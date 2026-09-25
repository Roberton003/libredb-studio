import type { McpConnectionContext } from "./context";
import type { McpCancellationManager } from "./guards/cancellation";
import { executeListConnections } from "./tools/list-connections";
import { executeInspectSchema } from "./tools/inspect-schema";
import { executeRunReadQuery } from "./tools/run-read-query";
import { JSON_RPC_ERRORS, type JsonRpcRequest, type JsonRpcResponse, type McpToolDefinition } from "./types";
import { redactError } from "./serializer";
import { logger } from "@/lib/logger";

export interface McpRequestContext {
  cancellationManager?: McpCancellationManager;
  signal?: AbortSignal;
  callerId?: string;
}

const MCP_TOOLS_DEFINITIONS: McpToolDefinition[] = [
  {
    name: "list_connections",
    description: "List all database connections configured in LibreDB Studio without exposing credentials.",
    inputSchema: {
      type: "object",
      properties: {
        environment: {
          type: "string",
          enum: ["all", "development", "staging", "production", "local", "other"],
          default: "all",
          description: "Filter connections by environment tier.",
        },
      },
    },
  },
  {
    name: "inspect_schema",
    description:
      "Inspect catalog schemas, tables, columns, and indexes with pagination support across all supported databases.",
    inputSchema: {
      type: "object",
      required: ["connection_id"],
      properties: {
        connection_id: { type: "string", description: "LibreDB Studio connection identifier." },
        schema: { type: "string", description: "Target schema name or database catalog." },
        table: { type: "string", description: "Specific table name to inspect." },
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
      "Execute a strictly read-only SQL query (SELECT / WITH) with strict execution guardrails and timeouts.",
    inputSchema: {
      type: "object",
      required: ["connection_id", "sql"],
      properties: {
        connection_id: { type: "string", description: "LibreDB Studio connection identifier." },
        sql: { type: "string", description: "Read-only SQL statement to execute." },
        max_rows: { type: "integer", minimum: 1, maximum: 500, default: 100 },
        offset: { type: "integer", minimum: 0, default: 0 },
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
      if (responses.length === 0) {
        return null;
      }
      const maxBatchWireBytes = 64 * 1024;
      let totalBytes = Buffer.byteLength(JSON.stringify(responses), "utf-8");
      if (totalBytes > maxBatchWireBytes) {
        logger.warn("MCP batch response wire budget exceeded, replacing overflow responses with per-id errors", {
          totalBytes,
          maxBatchWireBytes,
          batchCount: responses.length,
        });
        for (let i = responses.length - 1; i >= 0; i--) {
          if (totalBytes <= maxBatchWireBytes) {
            break;
          }
          const prev = responses[i];
          responses[i] = {
            jsonrpc: "2.0",
            id: prev.id,
            error: {
              code: JSON_RPC_ERRORS.INTERNAL_ERROR,
              message: "Response exceeded the MCP batch output limit",
            },
          };
          totalBytes = Buffer.byteLength(JSON.stringify(responses), "utf-8");
        }
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

    const isValidId = (typeof id === "string" && id.length <= 256) || (typeof id === "number" && Number.isInteger(id));
    const safeId = isValidId ? id : null;

    if (jsonrpc !== "2.0" || typeof method !== "string") {
      return {
        jsonrpc: "2.0",
        id: safeId,
        error: {
          code: JSON_RPC_ERRORS.INVALID_REQUEST,
          message: "Invalid Request: 'jsonrpc' must be '2.0' and 'method' must be a string",
        },
      };
    }

    // If id is provided (RPC request, not notification), validate MCP conformance
    if (id !== undefined && !isValidId) {
      return {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: JSON_RPC_ERRORS.INVALID_REQUEST,
          message: "Invalid Request: 'id' must be a string (max 256 chars) or an integer",
        },
      };
    }

    // If params is provided, it must be a structured object or array
    if (params !== undefined && (typeof params !== "object" || params === null)) {
      return {
        jsonrpc: "2.0",
        id: safeId,
        error: {
          code: JSON_RPC_ERRORS.INVALID_PARAMS,
          message: "Invalid params: must be a structured object or array when provided",
        },
      };
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
          const callerId = requestContext?.callerId || "anonymous";
          if (manager && (typeof reqId === "string" || typeof reqId === "number")) {
            void manager.handleCancellation(callerId, reqId, cancelParams?.reason);
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
    } catch (err: unknown) {
      const safeError = redactError(err);
      logger.error("Error dispatching MCP request", safeError, { method });
      return isNotification
        ? null
        : {
            jsonrpc: "2.0",
            id,
            error: {
              code: JSON_RPC_ERRORS.INTERNAL_ERROR,
              message: safeError.message,
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
        return executeInspectSchema(args, this.context, {
          callerId: requestContext?.callerId,
        });

      case "run_read_query":
        return executeRunReadQuery(args, this.context, {
          requestId,
          callerId: requestContext?.callerId,
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
