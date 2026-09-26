import { NextResponse } from "next/server";
import { guardRoute } from "@/lib/api/require-session";
import { getSession } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { recordMcpMint } from "@/lib/mcp/audit";
import { mcpChannelStatus } from "@/lib/mcp/config";
import { MCP_CONNECTIONS_UNREADABLE, McpConnectionContext } from "@/lib/mcp/context";
import { mintMcpToken } from "@/lib/mcp/token";

export const dynamic = "force-dynamic";

/**
 * /api/mcp/token (#246): where a signed-in user learns whether MCP is ready and mints a token of
 * their own. It is on the ordinary session path, so an MCP bearer authenticates nothing here and a
 * token can never mint a token.
 *
 * GET reads the status with getSession and is charged nothing, because a screen that must ask
 * whether a feature is ready before it renders cannot spend the budget of the work. POST goes
 * through guardRoute, takes no body field (the owner is always the session's user, with the
 * session's role), refuses with the configuration's problems when the channel is not ready,
 * records the mint before it signs, and answers the token once, marked no-store. Nothing about a
 * token is stored.
 */

const NOT_ISSUED = "MCP tokens cannot be issued on this server";
const AUDIT_FAILED = "The token was not issued because its audit record could not be written.";
const SEED_UNREADABLE =
  "The seed connection file could not be read, so the connections an MCP token reaches are unknown; the server log names the cause";
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const status = mcpChannelStatus();
  const visible = await new McpConnectionContext({
    username: session.username,
    role: session.role,
  }).visibleConnections();
  const readable = visible !== MCP_CONNECTIONS_UNREADABLE;
  return NextResponse.json(
    {
      state: status.state,
      problems: readable ? [...status.problems] : [...status.problems, SEED_UNREADABLE],
      url: status.url,
      tokenTtlDays: status.tokenTtlDays,
      visibleConnections: readable ? visible.length : null,
    },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request): Promise<Response> {
  const guard = await guardRoute({ route: "POST /api/mcp/token", bucket: "query", request });
  if ("response" in guard) return guard.response;
  const status = mcpChannelStatus();
  if (status.state !== "ready") {
    return NextResponse.json({ error: NOT_ISSUED, problems: [...status.problems] }, { status: 409, headers: NO_STORE });
  }
  try {
    recordMcpMint(guard.session.username);
  } catch (auditError) {
    logger.error("An MCP token mint could not be recorded, so no token was issued", auditError, {
      route: "POST /api/mcp/token",
    });
    return NextResponse.json({ error: AUDIT_FAILED }, { status: 500, headers: NO_STORE });
  }
  const minted = await mintMcpToken({ username: guard.session.username, role: guard.session.role });
  return NextResponse.json(
    { token: minted.token, expiresAt: minted.expiresAt.toISOString(), url: minted.url },
    { headers: NO_STORE },
  );
}
