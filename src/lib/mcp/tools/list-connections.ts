import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { McpConnectionContext, McpToolCall } from "../context";
import { safeJsonStringify } from "../serializer";

export const ListConnectionsInputSchema = z.object({
  environment: z.enum(["all", "development", "staging", "production", "local", "other"]).optional().default("all"),
});

export type ListConnectionsInput = z.infer<typeof ListConnectionsInputSchema>;

export interface PublicConnectionMetadata {
  id: string;
  name: string;
  engine: string;
  database?: string;
  read_only: boolean;
  environment?: string;
}

/** Lists the caller's connections without credentials. */
async function listConnections(args: ListConnectionsInput, call: McpToolCall): Promise<CallToolResult> {
  const listed: PublicConnectionMetadata[] = (await call.context.visibleConnections())
    .filter((connection) => args.environment === "all" || connection.environment === args.environment)
    .map((connection) => ({
      id: connection.id,
      name: connection.name,
      engine: connection.type,
      database: connection.database,
      read_only: connection.environment === "production",
      environment: connection.environment,
    }));
  return { content: [{ type: "text", text: safeJsonStringify(listed, 2) }] };
}

export function registerListConnections(server: McpServer, context: McpConnectionContext): void {
  server.registerTool(
    "list_connections",
    {
      description: "List all database connections configured in LibreDB Studio without exposing credentials.",
      inputSchema: ListConnectionsInputSchema,
    },
    (args, ctx) => listConnections(args, { context, signal: ctx.mcpReq.signal }),
  );
}
