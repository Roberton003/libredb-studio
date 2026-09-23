import type { McpConnectionContext } from "../context";
import { safeJsonStringify, redactErrorMessage } from "../serializer";
import { type ListConnectionsInput, ListConnectionsInputSchema, type McpCallResult } from "../types";

/**
 * Lists configured database connections safely with zero credential leakage.
 */
export async function executeListConnections(args: unknown, context: McpConnectionContext): Promise<McpCallResult> {
  try {
    const parsed: ListConnectionsInput = ListConnectionsInputSchema.parse(args || {});
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
          text: `Failed to list connections: ${redactErrorMessage(error?.message || String(error))}`,
        },
      ],
    };
  }
}
