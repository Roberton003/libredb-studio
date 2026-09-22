import type { McpConnectionContext } from "../context";
import type { McpCancellationManager } from "../guards/cancellation";
import { assertReadOnlyStatement } from "../guards/execution-fence";
import { safeJsonStringify, safeSerialize } from "../serializer";
import {
  type McpCallResult,
  type QueryResultEnvelope,
  type RunReadQueryInput,
  RunReadQueryInputSchema,
} from "../types";

const MAX_PAYLOAD_BYTES = 64 * 1024; // 64 KB teto defensivo para LLMs

export interface RunReadQueryOptions {
  requestId?: string | number | null;
  signal?: AbortSignal;
  cancellationManager?: McpCancellationManager;
}

/**
 * Executa uma consulta SQL em modo estritamente leitura protegida por acquireExecutionProfileProvider
 * e orçamento rigoroso de linhas, bytes e paginação 0.16.2.
 */
export async function executeRunReadQuery(
  rawArgs: unknown,
  context: McpConnectionContext,
  opts?: RunReadQueryOptions,
): Promise<McpCallResult> {
  const signal = opts?.signal;
  const cancellationManager = opts?.cancellationManager;

  // 0. Se a requisição já foi abortada pelo cliente antes de iniciar
  if (signal?.aborted) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Execution cancelled: ${signal.reason || "Client cancelled request"}`,
        },
      ],
    };
  }

  let args: RunReadQueryInput;
  try {
    args = RunReadQueryInputSchema.parse(rawArgs);
  } catch (err: any) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Invalid parameters: ${err?.message || String(err)}`,
        },
      ],
    };
  }

  const rawReqId = opts?.requestId !== undefined && opts?.requestId !== null ? String(opts.requestId) : null;
  const queryId = `mcp_${rawReqId ?? crypto.randomUUID()}`;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    // 1. Cerca de Execução Fail-Closed (Defesa em Profundidade: AST / Regex)
    assertReadOnlyStatement(args.sql);

    // 2. Barreira Canônica: acquireExecutionProfileProvider com perfil "agent-read-only"
    const connConfig =
      typeof context.getConnection === "function" ? context.getConnection(args.connection_id) : undefined;
    const isMemoryTarget =
      connConfig?.type === "sqlite" && (!connConfig.database || connConfig.database === ":memory:");

    let provider: any;
    try {
      provider = await context.getProvider(args.connection_id, "agent-read-only");
    } catch (err: any) {
      // Apenas conexões comprovadamente SQLite em memória (:memory:) que reportam incompatibilidade tipada usam fallback (#328)
      if (isMemoryTarget && err?.reasonCode === "PROFILE_UNSUPPORTED_TARGET") {
        provider = await context.getProvider(args.connection_id);
      } else {
        throw err;
      }
    }

    // Se o cliente abortou durante a inicialização/conexão do provider
    if (signal?.aborted) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Execution cancelled: ${signal.reason || "Client cancelled request"}`,
          },
        ],
      };
    }

    const startTime = Date.now();

    // Registrar no cancellationManager se disponível (mapeando queryId e rawReqId para resolução cruzada)
    let cancelSignal: AbortSignal | undefined;
    if (cancellationManager) {
      const cancelDatabaseOperation = async () => {
        if (provider && typeof (provider as any).cancelQuery === "function") {
          await (provider as any).cancelQuery(queryId);
        }
      };
      cancelSignal = cancellationManager.register(queryId, args.connection_id, cancelDatabaseOperation);
      if (rawReqId && rawReqId !== queryId) {
        cancellationManager.registerAlias(rawReqId, queryId);
      }

      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            cancellationManager.handleCancellation(queryId, signal.reason);
            if (rawReqId) {
              cancellationManager.handleCancellation(rawReqId, signal.reason);
            }
          },
          { once: true },
        );
      }
    }

    // 3. Preparação com Paginação (Contrato 0.16.2 / #816)
    const prepared =
      typeof provider.prepareQuery === "function"
        ? provider.prepareQuery(args.sql, { limit: args.max_rows })
        : { query: args.sql, limit: args.max_rows, offset: 0, wasLimited: false };

    // 4. Execução protegida com timeout e promessa de cancelamento imediato (Fail-Fast)
    let rawResult: any;

    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        if (cancellationManager) {
          cancellationManager.handleCancellation(queryId, `Timeout after ${args.timeout_ms}ms`);
          if (rawReqId) cancellationManager.handleCancellation(rawReqId, `Timeout after ${args.timeout_ms}ms`);
        }
        reject(new Error(`Query timed out after ${args.timeout_ms}ms`));
      }, args.timeout_ms);
    });

    const abortPromise = new Promise<never>((_, reject) => {
      const onAbort = () => {
        const reason = cancelSignal?.reason || signal?.reason || "Query cancelled";
        const message = reason instanceof Error ? reason.message : String(reason);
        reject(new Error(`Execution cancelled: ${message}`));
      };

      if (signal?.aborted) return onAbort();
      if (cancelSignal?.aborted) return onAbort();

      signal?.addEventListener("abort", onAbort, { once: true });
      cancelSignal?.addEventListener("abort", onAbort, { once: true });
    });

    // Se o provider tiver suporte nativo ao perfil read-only do banco (#328), executa nativamente
    if ((provider as any).readOnlyProfile === true && typeof provider.queryReadOnly === "function") {
      rawResult = await Promise.race([
        provider.queryReadOnly(prepared.query, {
          maxResultRows: prepared.limit,
          statementTimeoutMs: args.timeout_ms,
          maxResultBytes: MAX_PAYLOAD_BYTES,
        }),
        timeoutPromise,
        abortPromise,
      ]);
    } else {
      // Fallback para query padrão protegida (bancos em memória ou sem perfil nativo)
      rawResult = await Promise.race([
        provider.query(prepared.query, undefined, queryId),
        timeoutPromise,
        abortPromise,
      ]);
    }

    const executionTimeMs = Date.now() - startTime;
    const rawRows = (rawResult.rows || []) as Array<Record<string, unknown>>;
    const originalCount = rawRows.length;

    // 5. Paginação e teto de linhas (Contrato 0.16.2)
    const hasMore = prepared.wasLimited && originalCount === prepared.limit;
    const cappedRows = rawRows.slice(0, prepared.limit);
    let hasFieldTruncation = false;

    // 6. Verificação do teto de bytes com Serializador Seguro e Medição no Envelope Completo (Wire Bytes)
    let safeRows = safeSerialize(cappedRows) as Array<Record<string, unknown>>;
    let fields: Array<{ name: string }> | undefined = rawResult.fields?.map((f: unknown) => {
      const rawName = typeof f === "string" ? f : String(f);
      if (rawName.length > 64) {
        hasFieldTruncation = true;
        return { name: `${rawName.slice(0, 64)}... [TRUNCATED]` };
      }
      return { name: rawName };
    });

    let truncated = (prepared.wasLimited && hasMore) || originalCount > prepared.limit || hasFieldTruncation;

    function truncateDeepValue(val: unknown, maxLen: number): unknown {
      if (typeof val === "string") {
        return val.length > maxLen ? `${val.slice(0, maxLen)}... [TRUNCATED]` : val;
      }
      if (val !== null && typeof val === "object") {
        const str = safeJsonStringify(val);
        if (str.length > maxLen) {
          return `${str.slice(0, maxLen)}... [TRUNCATED OBJECT]`;
        }
      }
      return val;
    }

    const buildEnvelopeCandidate = (
      r: Array<Record<string, unknown>>,
      f: Array<{ name: string }> | undefined,
      isTruncated: boolean,
    ) => {
      const env: QueryResultEnvelope = {
        connection_id: args.connection_id.length > 64 ? `${args.connection_id.slice(0, 64)}...` : args.connection_id,
        rows: r,
        row_count: r.length,
        truncated: isTruncated,
        byte_size: 0,
        execution_time_ms: executionTimeMs,
        fields: f,
        pagination: {
          limit: prepared.limit,
          offset: prepared.offset,
          hasMore,
          totalReturned: originalCount,
          wasLimited: prepared.wasLimited,
        },
      };

      // Estabiliza o cálculo iterativo de byte_size para garantir concordância absoluta com os bytes UTF-8 no fio
      let txt = safeJsonStringify(env, 2);
      for (let i = 0; i < 3; i++) {
        const currentBytes = Buffer.byteLength(txt, "utf-8");
        if (env.byte_size === currentBytes) break;
        env.byte_size = currentBytes;
        txt = safeJsonStringify(env, 2);
      }
      const finalBytes = Buffer.byteLength(txt, "utf-8");
      return { env, txt, wireBytes: finalBytes };
    };

    let candidate = buildEnvelopeCandidate(safeRows, fields, truncated);

    if (candidate.wireBytes > MAX_PAYLOAD_BYTES) {
      // Passo A: Se houver mais de 50 colunas nos metadados, limita fields para proteger o wire budget
      if (fields && fields.length > 50) {
        fields = [
          ...fields.slice(0, 50),
          { name: `... [TRUNCATED: ${fields.length - 50} colunas adicionais omitidas]` },
        ];
        truncated = true;
        candidate = buildEnvelopeCandidate(safeRows, fields, truncated);
      }

      // Passo B: Redução geométrica de linhas (75% por iteração)
      while (safeRows.length > 1 && candidate.wireBytes > MAX_PAYLOAD_BYTES) {
        safeRows = safeRows.slice(0, Math.floor(safeRows.length * 0.75));
        truncated = true;
        candidate = buildEnvelopeCandidate(safeRows, fields, truncated);
      }

      // Passo C: Truncamento de chaves, strings e objetos aninhados profundos (256 -> 128 -> 64 -> 32 -> 16)
      if (candidate.wireBytes > MAX_PAYLOAD_BYTES && safeRows.length > 0) {
        let maxFieldLen = 256;
        while (candidate.wireBytes > MAX_PAYLOAD_BYTES && maxFieldLen >= 16) {
          const maxKeyLen = Math.max(32, maxFieldLen);
          safeRows = safeRows.map((row) => {
            const trimmed: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(row)) {
              const safeKey = k.length > maxKeyLen ? `${k.slice(0, maxKeyLen)}...` : k;
              trimmed[safeKey] = truncateDeepValue(v, maxFieldLen);
            }
            return trimmed;
          });
          truncated = true;
          candidate = buildEnvelopeCandidate(safeRows, fields, truncated);
          maxFieldLen = Math.floor(maxFieldLen / 2);
        }
      }

      // Passo D: Se ainda ultrapassar 64 KiB, poda colunas excedentes nas linhas e metadados
      if (candidate.wireBytes > MAX_PAYLOAD_BYTES && safeRows.length > 0) {
        safeRows = safeRows.map((row) => {
          const entries = Object.entries(row);
          const cappedEntries = entries.slice(0, Math.min(entries.length, 25));
          const trimmed: Record<string, unknown> = Object.fromEntries(cappedEntries);
          trimmed["_truncation_warning"] = "[TRUNCATED: colunas excedentes omitidas para respeitar o teto de 64 KB]";
          return trimmed;
        });
        if (fields && fields.length > 25) {
          fields = [...fields.slice(0, 25), { name: "... [TRUNCATED: colunas excedentes omitidas]" }];
        }
        truncated = true;
        candidate = buildEnvelopeCandidate(safeRows, fields, truncated);
      }

      // Passo E: Salvaguarda final em linhas e metadados
      if (candidate.wireBytes > MAX_PAYLOAD_BYTES && safeRows.length > 1) {
        safeRows = safeRows.slice(0, 1);
        truncated = true;
        candidate = buildEnvelopeCandidate(safeRows, fields, truncated);
      }
      if (candidate.wireBytes > MAX_PAYLOAD_BYTES && fields && fields.length > 10) {
        fields = fields.slice(0, 10);
        truncated = true;
        candidate = buildEnvelopeCandidate(safeRows, fields, truncated);
      }

      // Passo F: Salvaguarda absoluta hermética (< 64 KiB garantido matematicamente)
      if (candidate.wireBytes > MAX_PAYLOAD_BYTES) {
        safeRows = [];
        fields = undefined;
        truncated = true;
        candidate = buildEnvelopeCandidate(safeRows, fields, truncated);
      }
    }

    return {
      content: [
        {
          type: "text",
          text: candidate.txt,
        },
      ],
    };
  } catch (error: any) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Execution failed: ${error?.message || String(error)}`,
        },
      ],
    };
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (cancellationManager) {
      cancellationManager.deregister(queryId);
      if (rawReqId) {
        cancellationManager.deregister(rawReqId);
      }
    }
  }
}

/**
 * Registra a ferramenta `run_read_query` no McpServer (SDK STDIO)
 */
export function registerRunReadQueryTool(
  server: any,
  context: McpConnectionContext,
  cancellationManager?: McpCancellationManager,
): void {
  server.tool(
    "run_read_query",
    "Executa uma consulta SQL em modo estritamente leitura (SELECT / WITH) com orçamento rigoroso de linhas e bytes",
    RunReadQueryInputSchema.shape,
    async (args: RunReadQueryInput, extra?: any) => {
      return executeRunReadQuery(args, context, {
        requestId: extra?.requestId,
        signal: extra?.signal,
        cancellationManager,
      });
    },
  );
}
