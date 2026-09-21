import type { McpConnectionContext } from "../context";
import type { McpCancellationManager } from "../guards/cancellation";
import { assertReadOnlyStatement } from "../guards/execution-fence";
import { safeJsonStringify, safeSerialize } from "../serializer";
import { type QueryResultEnvelope, type RunReadQueryInput, RunReadQueryInputSchema } from "../types";

const MAX_PAYLOAD_BYTES = 64 * 1024; // 64 KB teto defensivo para LLMs

/**
 * Registra a ferramenta `run_read_query` no McpServer
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
      // 0. Se a requisição já foi abortada pelo cliente antes de iniciar
      if (extra?.signal?.aborted) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Execution cancelled: ${extra.signal.reason || "Client cancelled request"}`,
            },
          ],
        };
      }

      const queryId = `mcp_${extra?.requestId !== undefined && extra.requestId !== null ? String(extra.requestId) : crypto.randomUUID()}`;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

      try {
        // 1. Cerca de Execução Fail-Closed (Camada 1: Validação de AST)
        assertReadOnlyStatement(args.sql);

        const provider = await context.getProvider(args.connection_id);

        // Se o cliente abortou durante a inicialização/conexão do provider
        if (extra?.signal?.aborted) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Execution cancelled: ${extra.signal.reason || "Client cancelled request"}`,
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

          if (extra?.signal) {
            extra.signal.addEventListener(
              "abort",
              () => {
                cancellationManager.handleCancellation(queryId, extra.signal.reason);
              },
              { once: true },
            );
          }
        }

        // 2. Execução protegida com timeout limpo
        let rawResult: any;

        const timeoutPromise = new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => {
            if (cancellationManager) {
              cancellationManager.handleCancellation(queryId, `Timeout after ${args.timeout_ms}ms`);
            }
            reject(new Error(`Query timed out after ${args.timeout_ms}ms`));
          }, args.timeout_ms);
        });

        // Se o provider tiver suporte nativo ao perfil read-only do banco (#328), tenta ele primeiro
        if (typeof provider.queryReadOnly === "function") {
          try {
            rawResult = await Promise.race([
              provider.queryReadOnly(args.sql, {
                maxResultRows: args.max_rows,
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
            // Apenas faz fallback se o engine recusar o perfil de arquivo em banco em memória (#328)
            const isUnsupportedMemory =
              err?.message?.includes(":memory:") ||
              err?.message?.includes("not supported") ||
              err?.message?.includes("profile");
            if (isUnsupportedMemory) {
              rawResult = await Promise.race([provider.query(args.sql, undefined, queryId), timeoutPromise]);
            } else {
              throw err;
            }
          }
        } else {
          // Fallback para query padrão protegida pela cerca
          rawResult = await Promise.race([provider.query(args.sql, undefined, queryId), timeoutPromise]);
        }

        const executionTimeMs = Date.now() - startTime;
        const rawRows = (rawResult.rows || []) as Array<Record<string, unknown>>;
        const originalCount = rawRows.length;

        // 3. Aplicação do teto de linhas (Row Budget Ceiling)
        const cappedRows = rawRows.slice(0, args.max_rows);
        let truncated = originalCount > args.max_rows;

        // 4. Verificação do teto de bytes com Serializador Seguro (Prevenção de crash com BigInt/BLOB)
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

          // Se mesmo com poucas ou 1 linha ainda ultrapassa 64 KB (ex: 80 colunas de 1 KiB ou texto gigante):
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

            // Se ainda assim exceder 64 KB (ex: centenas de colunas), corta o número de colunas
            if (byteSize > MAX_PAYLOAD_BYTES && safeRows.length > 0) {
              safeRows = safeRows.map((row) => {
                const entries = Object.entries(row);
                const cappedEntries = entries.slice(0, Math.min(entries.length, 25));
                const trimmed: Record<string, unknown> = Object.fromEntries(cappedEntries);
                trimmed["_truncation_warning"] =
                  "[TRUNCATED: colunas excedentes omitidas para respeitar o teto de 64 KB]";
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
        // Contrato MCP oficial de erro: retorna isError: true sem derrubar a sessão STDIO
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
    },
  );
}
