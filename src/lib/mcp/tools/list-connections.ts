import type { McpConnectionContext } from "../context";
import { safeJsonStringify } from "../serializer";
import { type ListConnectionsInput, ListConnectionsInputSchema, type McpCallResult } from "../types";

/**
 * Executa a listagem de conexões de forma segura e com Zero-Leakage de credenciais.
 */
export async function executeListConnections(args: unknown, context: McpConnectionContext): Promise<McpCallResult> {
  try {
    const parsed = ListConnectionsInputSchema.parse(args || {});
    const connections = context.listPublicConnections(parsed.environment);
    return {
      content: [
        {
          type: "text",
          text: safeJsonStringify(connections, 2),
        },
      ],
    };
  } catch (error: any) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Failed to list connections: ${error?.message || String(error)}`,
        },
      ],
    };
  }
}

/**
 * Registra a ferramenta `list_connections` no McpServer (SDK STDIO)
 */
export function registerListConnectionsTool(server: any, context: McpConnectionContext): void {
  server.tool(
    "list_connections",
    "Lista todas as conexões de banco de dados disponíveis no LibreDB Studio (sem expor credenciais)",
    ListConnectionsInputSchema.shape,
    async (args: ListConnectionsInput) => {
      return executeListConnections(args, context);
    },
  );
}
