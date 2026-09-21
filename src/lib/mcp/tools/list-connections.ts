import type { McpConnectionContext } from "../context";
import { safeJsonStringify } from "../serializer";
import { type ListConnectionsInput, ListConnectionsInputSchema } from "../types";

/**
 * Registra a ferramenta `list_connections` no McpServer
 */
export function registerListConnectionsTool(server: any, context: McpConnectionContext): void {
  server.tool(
    "list_connections",
    "Lista todas as conexões de banco de dados disponíveis no LibreDB Studio (sem expor credenciais)",
    ListConnectionsInputSchema.shape,
    async (args: ListConnectionsInput) => {
      try {
        const connections = context.listPublicConnections(args.environment);
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
    },
  );
}
