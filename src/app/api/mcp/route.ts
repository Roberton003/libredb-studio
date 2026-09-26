import type { AuthInfo } from "@modelcontextprotocol/server";
import { guardRoute } from "@/lib/api/require-session";
import type { UserPayload } from "@/lib/auth";
import { mcpHandler } from "@/lib/mcp/server";

export const dynamic = "force-dynamic";

/**
 * The session guardRoute admitted, as the identity the SDK hands the server factory. It exists
 * only while this route still admits a Studio session; the scoped bearer token replaces it.
 */
function sessionAuthInfo(session: UserPayload): AuthInfo {
  return {
    token: "studio-session",
    clientId: `session:${session.username}`,
    scopes: ["mcp:read"],
    extra: { username: session.username, role: session.role },
  };
}

export async function POST(request: Request): Promise<Response> {
  const guard = await guardRoute({ route: "POST /api/mcp", bucket: "query", request });
  if ("response" in guard) return guard.response;
  return mcpHandler.fetch(request, { authInfo: sessionAuthInfo(guard.session) });
}

/**
 * GET and DELETE are answered by the SDK's stateless legacy leg with 405 before any server is
 * built. RFC 9110 section 15.5.6 makes Allow a MUST on every 405, so it is added and nothing else
 * in the SDK's answer changes. Exported at all because Next.js would otherwise answer an
 * unexported method with a 405 of its own and no JSON-RPC body.
 */
async function answerWithoutSession(request: Request): Promise<Response> {
  const response = await mcpHandler.fetch(request);
  const headers = new Headers(response.headers);
  headers.set("Allow", "POST");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function GET(request: Request): Promise<Response> {
  return answerWithoutSession(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return answerWithoutSession(request);
}
