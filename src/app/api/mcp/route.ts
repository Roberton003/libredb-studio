import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getManagedConnections } from "@/lib/seed";
import { McpConnectionContext } from "@/lib/mcp/context";
import { McpDispatcher } from "@/lib/mcp/dispatcher";
import { McpCancellationManager } from "@/lib/mcp/guards/cancellation";
import { JSON_RPC_ERRORS } from "@/lib/mcp/types";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export const MCP_TOKEN_HEADER = "x-libredb-mcp-token";

/**
 * Ponto de extensão de autenticação (Auth Seam).
 * Suporta autenticação via cookie de sessão do LibreDB Studio e
 * prepara o canal para o scoped token derivado de JWT_SECRET mantido pelo core team (#246).
 */
async function authenticateMcpRequest(req: NextRequest): Promise<{ authenticated: boolean; role: string }> {
  const session = await getSession();
  if (session) {
    return { authenticated: true, role: session.role };
  }

  const token = req.headers.get(MCP_TOKEN_HEADER) || req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

  if (token) {
    // Se um MCP_TOKEN estático foi configurado em ambiente de teste ou dev:
    if (process.env.MCP_TOKEN && token === process.env.MCP_TOKEN) {
      return { authenticated: true, role: "admin" };
    }
  }

  return { authenticated: false, role: "none" };
}

/**
 * GET /api/mcp
 * Descoberta e health check do endpoint MCP do LibreDB Studio.
 */
export async function GET() {
  return NextResponse.json({
    status: "ok",
    protocol: "mcp",
    protocolVersion: "2024-11-05",
    server: "libredb-studio-mcp",
    version: "0.16.2",
    endpoint: "/api/mcp",
    auth: ["session", "x-libredb-mcp-token"],
  });
}

/**
 * POST /api/mcp
 * Manipulador JSON-RPC 2.0 oficial para clientes MCP (Cursor, Claude Code, etc).
 */
export async function POST(req: NextRequest) {
  // 1. Verificação de Autenticação (Session ou Scoped Token)
  const auth = await authenticateMcpRequest(req);
  if (!auth.authenticated) {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32000,
          message: "Unauthorized: Authentication required via session cookie or 'x-libredb-mcp-token' header",
        },
      },
      { status: 401 },
    );
  }

  // 2. Leitura do payload JSON-RPC
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

  // 3. Resolução de conexões disponíveis com base na role autenticada
  let connections: any[] = [];
  try {
    connections = await getManagedConnections([auth.role]);
  } catch (err) {
    logger.warn("Could not load managed connections for MCP session", { role: auth.role, err });
    connections = [];
  }

  // 4. Instanciação do Contexto e Dispatcher MCP com gerenciamento de ciclo de vida e cancelamento
  const cancellationManager = new McpCancellationManager();
  const context = new McpConnectionContext(connections);
  const dispatcher = new McpDispatcher(context, cancellationManager);

  try {
    const result = await dispatcher.handle(body, {
      signal: req.signal,
      cancellationManager,
    });

    if (result === null) {
      // Notificações JSON-RPC não exigem corpo de resposta
      return new NextResponse(null, { status: 204 });
    }

    return NextResponse.json(result);
  } catch (error: any) {
    logger.error("Unhandled error in MCP route handler", error);
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: JSON_RPC_ERRORS.INTERNAL_ERROR,
          message: error?.message || "Internal server error",
        },
      },
      { status: 500 },
    );
  } finally {
    await context.disconnectAll();
  }
}
