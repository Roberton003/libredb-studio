import type { McpConnectionContext } from "./context";
import type { McpCancellationManager } from "./guards/cancellation";
import { executeListConnections } from "./tools/list-connections";
import { executeInspectSchema } from "./tools/inspect-schema";
import { executeRunReadQuery } from "./tools/run-read-query";
import { JSON_RPC_ERRORS, type JsonRpcRequest, type JsonRpcResponse, type McpToolDefinition } from "./types";
import { logger } from "@/lib/logger";

export interface McpRequestContext {
  cancellationManager?: McpCancellationManager;
  signal?: AbortSignal;
}

export const MCP_TOOLS_DEFINITIONS: McpToolDefinition[] = [
  {
    name: "list_connections",
    description: "Lista todas as conexões de banco de dados disponíveis no LibreDB Studio (sem expor credenciais)",
    inputSchema: {
      type: "object",
      properties: {
        environment: {
          type: "string",
          enum: ["all", "development", "staging", "production", "local", "other"],
          default: "all",
          description: "Filtrar por ambiente da conexão",
        },
      },
    },
  },
  {
    name: "inspect_schema",
    description:
      "Inspeciona o catálogo e esquema de tabelas de uma conexão de forma paginada e defensiva através de todos os 17 bancos",
    inputSchema: {
      type: "object",
      required: ["connection_id"],
      properties: {
        connection_id: { type: "string", description: "ID da conexão no LibreDB Studio" },
        schema: { type: "string", description: "Nome do schema ou container alvo" },
        table: { type: "string", description: "Nome específico da tabela para inspecionar" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        offset: { type: "integer", minimum: 0, default: 0 },
        include_columns: { type: "boolean", default: true },
        include_indexes: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "run_read_query",
    description:
      "Executa uma consulta SQL em modo estritamente leitura (SELECT / WITH) com orçamento rigoroso de linhas e bytes",
    inputSchema: {
      type: "object",
      required: ["connection_id", "sql"],
      properties: {
        connection_id: { type: "string", description: "ID da conexão no LibreDB Studio" },
        sql: { type: "string", description: "Instrução SQL SELECT a ser executada" },
        max_rows: { type: "integer", minimum: 1, maximum: 500, default: 100 },
        timeout_ms: { type: "integer", minimum: 500, maximum: 30000, default: 10000 },
      },
    },
  },
];

export class McpDispatcher {
  constructor(
    private context: McpConnectionContext,
    private cancellationManager?: McpCancellationManager,
  ) {}

  public async handle(
    body: unknown,
    requestContext?: McpRequestContext,
  ): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    if (Array.isArray(body)) {
      if (body.length === 0) {
        return {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: JSON_RPC_ERRORS.INVALID_REQUEST,
            message: "Invalid Request: Batch request cannot be empty",
          },
        };
      }
      if (body.length > 50) {
        return {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: JSON_RPC_ERRORS.INVALID_REQUEST,
            message: "Invalid Request: Batch size exceeds limit of 50 requests",
          },
        };
      }
      const responses: JsonRpcResponse[] = [];
      for (const req of body) {
        const res = await this.handleSingle(req, requestContext);
        if (res) responses.push(res);
      }
      return responses;
    }
    return this.handleSingle(body, requestContext);
  }

  private async handleSingle(req: unknown, requestContext?: McpRequestContext): Promise<JsonRpcResponse | null> {
    if (typeof req !== "object" || req === null) {
      return {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: JSON_RPC_ERRORS.INVALID_REQUEST,
          message: "Invalid Request: Expected a JSON object",
        },
      };
    }

    const { jsonrpc, id, method, params } = req as Partial<JsonRpcRequest>;

    if (jsonrpc !== "2.0" || typeof method !== "string") {
      return {
        jsonrpc: "2.0",
        id: id ?? null,
        error: {
          code: JSON_RPC_ERRORS.INVALID_REQUEST,
          message: "Invalid Request: 'jsonrpc' must be '2.0' and 'method' must be a string",
        },
      };
    }

    // Se id foi fornecido (requisição RPC, não notificação), validar conformidade MCP (string ou inteiro)
    if (id !== undefined) {
      const isValidId = typeof id === "string" || (typeof id === "number" && Number.isInteger(id));
      if (!isValidId) {
        return {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: JSON_RPC_ERRORS.INVALID_REQUEST,
            message: "Invalid Request: 'id' must be a string or an integer (cannot be null or float)",
          },
        };
      }
    }

    const isNotification = id === undefined;

    try {
      switch (method) {
        case "initialize": {
          const result = {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: { listChanged: false },
            },
            serverInfo: {
              name: "libredb-studio-mcp",
              version: "0.16.2",
            },
          };
          return isNotification ? null : { jsonrpc: "2.0", id, result };
        }

        case "notifications/initialized": {
          return null;
        }

        case "notifications/cancelled": {
          const cancelParams = params as { requestId?: unknown; reason?: string } | undefined;
          const reqId = cancelParams?.requestId;
          const manager = this.cancellationManager || requestContext?.cancellationManager;
          if (manager && (typeof reqId === "string" || typeof reqId === "number")) {
            await manager.handleCancellation(String(reqId), cancelParams?.reason);
            await manager.handleCancellation(`mcp_${reqId}`, cancelParams?.reason);
          }
          return null;
        }

        case "ping": {
          return isNotification ? null : { jsonrpc: "2.0", id, result: {} };
        }

        case "tools/list": {
          return isNotification ? null : { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS_DEFINITIONS } };
        }

        case "tools/call": {
          const toolParams = params as { name?: unknown; arguments?: unknown } | undefined;
          const toolName = toolParams?.name;
          const toolArgs = toolParams?.arguments || {};

          if (typeof toolName !== "string") {
            return isNotification
              ? null
              : {
                  jsonrpc: "2.0",
                  id,
                  error: {
                    code: JSON_RPC_ERRORS.INVALID_PARAMS,
                    message: "Invalid params: 'name' is required for tools/call",
                  },
                };
          }

          const callResult = await this.executeTool(toolName, toolArgs, id, requestContext);
          return isNotification ? null : { jsonrpc: "2.0", id, result: callResult };
        }

        default: {
          return isNotification
            ? null
            : {
                jsonrpc: "2.0",
                id,
                error: {
                  code: JSON_RPC_ERRORS.METHOD_NOT_FOUND,
                  message: `Method not found: "${method}"`,
                },
              };
        }
      }
    } catch (err: any) {
      logger.error("Error dispatching MCP request", err, { method });
      return isNotification
        ? null
        : {
            jsonrpc: "2.0",
            id,
            error: {
              code: JSON_RPC_ERRORS.INTERNAL_ERROR,
              message: err?.message || "Internal server error during MCP dispatch",
            },
          };
    }
  }

  private async executeTool(
    name: string,
    args: unknown,
    requestId?: string | number | null,
    requestContext?: McpRequestContext,
  ) {
    switch (name) {
      case "list_connections":
        return executeListConnections(args, this.context);

      case "inspect_schema":
        return executeInspectSchema(args, this.context);

      case "run_read_query":
        return executeRunReadQuery(args, this.context, {
          requestId,
          signal: requestContext?.signal,
          cancellationManager: this.cancellationManager || requestContext?.cancellationManager,
        });

      default:
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Unknown tool: "${name}". Available tools: ${MCP_TOOLS_DEFINITIONS.map((t) => t.name).join(", ")}`,
            },
          ],
        };
    }
  }
}
