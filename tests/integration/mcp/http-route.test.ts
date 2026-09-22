import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";

let mockSessionResult: { role: string; username: string } | null = { role: "admin", username: "admin" };

mock.module("@/lib/auth", () => ({
  getSession: mock(async () => mockSessionResult),
}));

mock.module("@/lib/seed", () => ({
  getManagedConnections: mock(async () => [
    {
      id: "demo-pg",
      name: "Demo Postgres",
      type: "postgres",
      database: "demo_db",
      environment: "production",
    },
    {
      id: "demo-sqlite",
      name: "Demo SQLite",
      type: "sqlite",
      database: ":memory:",
      environment: "local",
    },
  ]),
}));

import { GET, POST } from "@/app/api/mcp/route";
import { McpConnectionContext } from "@/lib/mcp/context";

describe("MCP Next.js Route Integration (/api/mcp)", () => {
  beforeEach(async () => {
    mockSessionResult = { role: "admin", username: "admin" };
    await McpConnectionContext.resetGlobalCache();
  });

  test("GET /api/mcp responde 200 com metadados do protocolo MCP", async () => {
    const response = await GET();
    expect(response.status).toBe(200);

    const body = await parseResponseJSON<any>(response);
    expect(body.status).toBe("ok");
    expect(body.protocol).toBe("mcp");
    expect(body.protocolVersion).toBe("2024-11-05");
    expect(body.server).toBe("libredb-studio-mcp");
  });

  test("POST /api/mcp rejeita requisição não autenticada com status 401", async () => {
    mockSessionResult = null;
    const req = createMockRequest("/api/mcp", {
      method: "POST",
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });

    const response = await POST(req as any);
    expect(response.status).toBe(401);

    const body = await parseResponseJSON<any>(response);
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toContain("Unauthorized");
  });

  test("POST /api/mcp aceita autenticação via scoped token header", async () => {
    mockSessionResult = null;
    process.env.MCP_TOKEN = "test-secret-mcp-token-xyz";

    const req = createMockRequest("/api/mcp", {
      method: "POST",
      headers: {
        "x-libredb-mcp-token": "test-secret-mcp-token-xyz",
      },
      body: { jsonrpc: "2.0", id: 10, method: "ping" },
    });

    const response = await POST(req as any);
    expect(response.status).toBe(200);

    const body = await parseResponseJSON<any>(response);
    expect(body.id).toBe(10);
    expect(body.result).toEqual({});
  });

  test("POST /api/mcp executa handshake 'initialize' com sucesso", async () => {
    const req = createMockRequest("/api/mcp", {
      method: "POST",
      body: {
        jsonrpc: "2.0",
        id: "init-1",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "cursor", version: "0.45.0" },
        },
      },
    });

    const response = await POST(req as any);
    expect(response.status).toBe(200);

    const body = await parseResponseJSON<any>(response);
    expect(body.id).toBe("init-1");
    expect(body.result.protocolVersion).toBe("2024-11-05");
    expect(body.result.serverInfo.name).toBe("libredb-studio-mcp");
  });

  test("POST /api/mcp lista ferramentas com 'tools/list'", async () => {
    const req = createMockRequest("/api/mcp", {
      method: "POST",
      body: {
        jsonrpc: "2.0",
        id: "tools-list-req",
        method: "tools/list",
      },
    });

    const response = await POST(req as any);
    expect(response.status).toBe(200);

    const body = await parseResponseJSON<any>(response);
    expect(body.result.tools).toBeArray();
    expect(body.result.tools.length).toBe(3);
  });

  test("POST /api/mcp executa 'tools/call' para 'list_connections'", async () => {
    const req = createMockRequest("/api/mcp", {
      method: "POST",
      body: {
        jsonrpc: "2.0",
        id: "call-1",
        method: "tools/call",
        params: {
          name: "list_connections",
          arguments: {},
        },
      },
    });

    const response = await POST(req as any);
    expect(response.status).toBe(200);

    const body = await parseResponseJSON<any>(response);
    expect(body.result.content).toBeArray();

    const data = JSON.parse(body.result.content[0].text);
    expect(data.length).toBe(2);
    expect(data[0].id).toBe("demo-pg");
    expect(data[0].engine).toBe("postgres");
  });

  test("POST /api/mcp executa 'tools/call' para 'run_read_query' com sucesso e paginação", async () => {
    const req = createMockRequest("/api/mcp", {
      method: "POST",
      body: {
        jsonrpc: "2.0",
        id: "call-query-1",
        method: "tools/call",
        params: {
          name: "run_read_query",
          arguments: {
            connection_id: "demo-sqlite",
            sql: "SELECT 2026 AS year, 'MCP' AS protocol",
          },
        },
      },
    });

    const response = await POST(req as any);
    expect(response.status).toBe(200);

    const body = await parseResponseJSON<any>(response);
    expect(body.result.isError).toBeFalsy();
    expect(body.result.content).toBeArray();

    const data = JSON.parse(body.result.content[0].text);
    expect(data.connection_id).toBe("demo-sqlite");
    expect(data.row_count).toBe(1);
    expect(data.rows[0].year).toBe(2026);
    expect(data.rows[0].protocol).toBe("MCP");
    expect(data.pagination).toBeDefined();
    expect(data.pagination.limit).toBe(100);
    expect(data.pagination.hasMore).toBe(false);
  });

  test("POST /api/mcp rejeita instrução destrutiva no 'run_read_query' com isError: true", async () => {
    const req = createMockRequest("/api/mcp", {
      method: "POST",
      body: {
        jsonrpc: "2.0",
        id: "call-drop-1",
        method: "tools/call",
        params: {
          name: "run_read_query",
          arguments: {
            connection_id: "demo-sqlite",
            sql: "DROP TABLE users",
          },
        },
      },
    });

    const response = await POST(req as any);
    expect(response.status).toBe(200);

    const body = await parseResponseJSON<any>(response);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("MCP execution fence rejected");
  });

  test("POST /api/mcp executa 'tools/call' para 'inspect_schema'", async () => {
    const req = createMockRequest("/api/mcp", {
      method: "POST",
      body: {
        jsonrpc: "2.0",
        id: "call-schema-1",
        method: "tools/call",
        params: {
          name: "inspect_schema",
          arguments: {
            connection_id: "demo-sqlite",
          },
        },
      },
    });

    const response = await POST(req as any);
    expect(response.status).toBe(200);

    const body = await parseResponseJSON<any>(response);
    expect(body.result.isError).toBeFalsy();
    expect(body.result.content).toBeArray();

    const data = JSON.parse(body.result.content[0].text);
    expect(data.connection_id).toBe("demo-sqlite");
    expect(data.tables).toBeArray();
  });

  test("POST /api/mcp responde 204 para notificações sem corpo", async () => {
    const req = createMockRequest("/api/mcp", {
      method: "POST",
      body: {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      },
    });

    const response = await POST(req as any);
    expect(response.status).toBe(204);
  });

  test("POST /api/mcp cancela query cross-request via notificação notifications/cancelled", async () => {
    const mockAsyncProvider = {
      readOnlyProfile: true,
      prepareQuery: (sql: string, opts: any) => ({ query: sql, limit: opts.limit, offset: 0, wasLimited: false }),
      queryReadOnly: async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { rows: [{ val: 1 }], fields: ["val"] };
      },
    };

    McpConnectionContext.setCachedProvider("demo-sqlite", "agent-read-only", mockAsyncProvider as any);
    McpConnectionContext.setCachedProvider("demo-sqlite", undefined, mockAsyncProvider as any);

    // Dispara POST 1 com query de longa duração
    const req1 = createMockRequest("/api/mcp", {
      method: "POST",
      body: {
        jsonrpc: "2.0",
        id: "slow-query-1",
        method: "tools/call",
        params: {
          name: "run_read_query",
          arguments: {
            connection_id: "demo-sqlite",
            sql: "SELECT 1",
            timeout_ms: 10000,
          },
        },
      },
    });

    const promise1 = POST(req1 as any);

    // Aguarda 20ms para garantir que a query iniciou no provider
    await new Promise((r) => setTimeout(r, 20));

    // Dispara POST 2 com notificação de cancelamento para o requestId "slow-query-1"
    const req2 = createMockRequest("/api/mcp", {
      method: "POST",
      body: {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: {
          requestId: "slow-query-1",
          reason: "User cancelled query via UI/MCP",
        },
      },
    });

    const response2 = await POST(req2 as any);
    expect(response2.status).toBe(204);

    const response1 = await promise1;
    expect(response1.status).toBe(200);

    const body1 = await parseResponseJSON<any>(response1);
    expect(body1.result.isError).toBe(true);
    expect(body1.result.content[0].text).toContain("cancelled");
  });
});
