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

  const queryId = `mcp_${opts?.requestId !== undefined && opts?.requestId !== null ? String(opts.requestId) : crypto.randomUUID()}`;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    // 1. Cerca de Execução Fail-Closed (Defesa em Profundidade: AST / Regex)
    assertReadOnlyStatement(args.sql);

    // 2. Barreira Canônica: acquireExecutionProfileProvider com perfil "agent-read-only"
    let provider: any;
    try {
      provider = await context.getProvider(args.connection_id, "agent-read-only");
    } catch (err: any) {
      // Bancos em memória (:memory:) não admitem handle somente-leitura em SO (#328)
      if (
        err?.reasonCode === "PROFILE_UNSUPPORTED_TARGET" ||
        err?.message?.toLowerCase().includes("in-memory") ||
        err?.message?.includes(":memory:")
      ) {
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

    // Registrar no cancellationManager se disponível
    if (cancellationManager) {
      const cancelDatabaseOperation = async () => {
        if (provider && typeof (provider as any).cancelQuery === "function") {
          await (provider as any).cancelQuery(queryId);
        }
      };
      cancellationManager.register(queryId, args.connection_id, cancelDatabaseOperation);

      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            cancellationManager.handleCancellation(queryId, signal.reason);
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

    // 4. Execução protegida com timeout limpo
    let rawResult: any;

    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        if (cancellationManager) {
          cancellationManager.handleCancellation(queryId, `Timeout after ${args.timeout_ms}ms`);
        }
        reject(new Error(`Query timed out after ${args.timeout_ms}ms`));
      }, args.timeout_ms);
    });

    // Se o provider tiver suporte nativo ao perfil read-only do banco (#328), executa nativamente
    if (typeof provider.queryReadOnly === "function") {
      try {
        rawResult = await Promise.race([
          provider.queryReadOnly(prepared.query, {
            maxResultRows: prepared.limit,
            statementTimeoutMs: args.timeout_ms,
            maxResultBytes: MAX_PAYLOAD_BYTES,
          }),
          timeoutPromise,
        ]);
      } catch (err: any) {
        // Se foi timeout, propaga imediatamente sem tentar o fallback
        if (err?.message?.includes("timed out")) {
          throw err;
        }
        // Apenas faz fallback se for banco em memória (:memory:) onde arquivo read-only não existe (#328)
        const isUnsupportedMemory =
          err?.message?.includes(":memory:") ||
          err?.message?.includes("not supported") ||
          err?.message?.includes("profile");
        if (isUnsupportedMemory) {
          rawResult = await Promise.race([provider.query(prepared.query, undefined, queryId), timeoutPromise]);
        } else {
          throw err;
        }
      }
    } else {
      // Fallback para query padrão protegida
      rawResult = await Promise.race([provider.query(prepared.query, undefined, queryId), timeoutPromise]);
    }

    const executionTimeMs = Date.now() - startTime;
    const rawRows = (rawResult.rows || []) as Array<Record<string, unknown>>;
    const originalCount = rawRows.length;

    // 5. Paginação e teto de linhas (Contrato 0.16.2)
    const hasMore = prepared.wasLimited && originalCount === prepared.limit;
    const cappedRows = rawRows.slice(0, prepared.limit);
    let truncated = (prepared.wasLimited && hasMore) || originalCount > prepared.limit;

    // 6. Verificação do teto de bytes com Serializador Seguro
    let safeRows = safeSerialize(cappedRows);
    let stringified = safeJsonStringify(safeRows);
    let byteSize = Buffer.byteLength(stringified, "utf-8");

    if (byteSize > MAX_PAYLOAD_BYTES) {
      while (safeRows.length > 1 && byteSize > MAX_PAYLOAD_BYTES) {
        safeRows = safeRows.slice(0, Math.floor(safeRows.length * 0.75));
        stringified = safeJsonStringify(safeRows);
        byteSize = Buffer.byteLength(stringified, "utf-8");
        truncated = true;
      }

      // Se mesmo com poucas linhas ainda ultrapassa 64 KB (ex: 80 colunas largas):
      if (byteSize > MAX_PAYLOAD_BYTES && safeRows.length > 0) {
        let maxFieldLen = 256;
        while (byteSize > MAX_PAYLOAD_BYTES && maxFieldLen >= 16) {
          safeRows = safeRows.map((row) => {
            const trimmed: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(row)) {
              if (typeof v === "string" && v.length > maxFieldLen) {
                trimmed[k] = `${v.slice(0, maxFieldLen)}... [TRUNCATED]`;
              } else {
                trimmed[k] = v;
              }
            }
            return trimmed;
          });
          stringified = safeJsonStringify(safeRows);
          byteSize = Buffer.byteLength(stringified, "utf-8");
          truncated = true;
          maxFieldLen = Math.floor(maxFieldLen / 2);
        }

        // Se ainda assim exceder 64 KB, corta colunas excedentes
        if (byteSize > MAX_PAYLOAD_BYTES && safeRows.length > 0) {
          safeRows = safeRows.map((row) => {
            const entries = Object.entries(row);
            const cappedEntries = entries.slice(0, Math.min(entries.length, 25));
            const trimmed: Record<string, unknown> = Object.fromEntries(cappedEntries);
            trimmed["_truncation_warning"] = "[TRUNCATED: colunas excedentes omitidas para respeitar o teto de 64 KB]";
            return trimmed;
          });
          stringified = safeJsonStringify(safeRows);
          byteSize = Buffer.byteLength(stringified, "utf-8");
          truncated = true;
        }
      }
    }

    const envelope: QueryResultEnvelope = {
      connection_id: args.connection_id,
      rows: safeRows,
      row_count: safeRows.length,
      truncated,
      byte_size: byteSize,
      execution_time_ms: executionTimeMs,
      fields: rawResult.fields?.map((f: unknown) => ({ name: typeof f === "string" ? f : String(f) })),
      pagination: {
        limit: prepared.limit,
        offset: prepared.offset,
        hasMore,
        totalReturned: originalCount,
        wasLimited: prepared.wasLimited,
      },
    };

    return {
      content: [
        {
          type: "text",
          text: safeJsonStringify(envelope, 2),
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
