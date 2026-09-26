import type { AuthInfo } from "@modelcontextprotocol/server";
import { clientAddress } from "@/lib/api/client-address";
import { createErrorResponse } from "@/lib/api/errors";
import { consumeRateLimit, RateLimitError } from "@/lib/api/rate-limit";
import { emitAuditEvent } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { mcpCaller } from "./context";
import type { McpToolName } from "./tools";

/**
 * What the route does with an authenticated POST before the SDK handler sees it (#246), in a fixed
 * order, each step answering before the next can run.
 *
 * Step 0 spends one slot of the query bucket, keyed on the user the token was minted for, which is
 * the key guardRoute uses for that user's session (src/lib/api/require-session.ts), so a session
 * and an MCP token of one person share one budget. It runs before the body is read, so a refused
 * POST costs no read at all. A metering step inside a tool could not answer 429: the SDK turns a
 * thrown error into an in-band tool result.
 */

const MCP_POST_ROUTE = "POST /api/mcp";

export type McpPreprocessOutcome =
  | { readonly kind: "refused"; readonly response: Response }
  | { readonly kind: "dispatch"; readonly parsedBody: unknown; readonly invalidArgumentsTool: McpToolName | null };

function meter(request: Request, username: string): Response | null {
  const decision = consumeRateLimit("query", username);
  if (decision.allowed) return null;
  if (decision.tripped) {
    // Isolated, as guardRoute isolates it: the 429 below is already decided.
    try {
      emitAuditEvent({
        type: "rate_limit_exceeded",
        action: "throttled",
        target: MCP_POST_ROUTE,
        user: username,
        result: "failure",
        reason: "rate_limited",
        ip: clientAddress(request),
        bucket: "query",
      });
    } catch (auditError) {
      logger.error("Failed to record rate_limit_exceeded audit event", auditError, { route: MCP_POST_ROUTE });
    }
  }
  return createErrorResponse(new RateLimitError(decision.retryAfterSeconds), { route: MCP_POST_ROUTE });
}

export async function preprocessMcpPost(request: Request, authInfo: AuthInfo): Promise<McpPreprocessOutcome> {
  const refusal = meter(request, mcpCaller(authInfo).username);
  if (refusal !== null) return { kind: "refused", response: refusal };
  return { kind: "dispatch", parsedBody: undefined, invalidArgumentsTool: null };
}
