import { NextRequest, NextResponse } from "next/server";
import { guardRoute } from "@/lib/api/require-session";
import { getManagedConnections } from "@/lib/seed";
import { McpConnectionContext } from "@/lib/mcp/context";
import { McpDispatcher } from "@/lib/mcp/dispatcher";
import { McpCancellationManager } from "@/lib/mcp/guards/cancellation";
import { JSON_RPC_ERRORS } from "@/lib/mcp/types";
import { redactError } from "@/lib/mcp/serializer";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * GET /api/mcp
 * Endpoint discovery and metadata for LibreDB Studio MCP server.
 */
export async function GET() {
  return NextResponse.json({
    status: "ok",
    protocol: "mcp",
    protocolVersion: "2024-11-05",
    server: "libredb-studio-mcp",
    version: "0.16.2",
    endpoint: "/api/mcp",
  });
}

// Shared cancellation manager instance across HTTP requests for this route
const globalMcpCancellationManager = new McpCancellationManager();

/**
 * POST /api/mcp
 * Official JSON-RPC 2.0 handler for MCP clients (Cursor, Claude Code, etc).
 */
export async function POST(req: NextRequest) {
  // 1. Session verification & Rate Limiting via standard LibreDB guardRoute
  const guard = await guardRoute({ route: "POST /api/mcp", bucket: "ai", request: req });
  if ("response" in guard) {
    return guard.response;
  }
  const { session } = guard;

  // 2. Read JSON-RPC payload
  let body: unknown;
  try {
    body = await req.json();
  } catch (err: any) {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: JSON_RPC_ERRORS.PARSE_ERROR,
          message: `Parse error: Invalid JSON payload (${err?.message || String(err)})`,
        },
      },
      { status: 400 },
    );
  }

  // 3. Resolve accessible connections based on authenticated role
  let connections: any[] = [];
  try {
    connections = await getManagedConnections([session.role]);
  } catch (err) {
    logger.warn("Could not load managed connections for MCP session", {
      role: session.role,
      error: redactError(err),
    });
    connections = [];
  }

  // 4. Instantiate context and dispatcher with cross-request cancellation and caller scoping
  const context = new McpConnectionContext(connections);
  const dispatcher = new McpDispatcher(context, globalMcpCancellationManager);

  try {
    const result = await dispatcher.handle(body, {
      signal: req.signal,
      cancellationManager: globalMcpCancellationManager,
      callerId: session.username,
    });

    if (result === null) {
      // JSON-RPC notifications do not return a response body
      return new NextResponse(null, { status: 204 });
    }

    return NextResponse.json(result);
  } catch (error: unknown) {
    const safeError = redactError(error);
    logger.error("Unhandled error in MCP route handler", safeError);
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: JSON_RPC_ERRORS.INTERNAL_ERROR,
          message: safeError.message,
        },
      },
      { status: 500 },
    );
  }
}
