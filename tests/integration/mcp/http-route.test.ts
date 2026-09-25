import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";

const TEST_DIR = mkdtempSync(join(tmpdir(), "libredb-mcp-"));
const TEST_DB_PATH = join(TEST_DIR, "test.db");

function setupTestDatabase() {
  if (existsSync(TEST_DB_PATH)) {
    try {
      unlinkSync(TEST_DB_PATH);
    } catch {}
  }
  const db = new Database(TEST_DB_PATH, { create: true });
  db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
  db.run("INSERT INTO users (id, name) VALUES (1, 'Alice'), (2, 'Bob')");
  db.close();
}

async function cleanupTestDatabase() {
  await McpConnectionContext.resetGlobalCache();
  if (existsSync(TEST_DIR)) {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
  }
}

let mockSessionResult: { role: string; username: string } | null = { role: "admin", username: "admin" };
let mockGetManagedConnectionsError: Error | null = null;

const authModule = "@/lib/auth";
mock.module(authModule, () => ({
  getSession: mock(async () => mockSessionResult),
}));

mock.module("@/lib/seed", () => ({
  getManagedConnections: mock(async () => {
    if (mockGetManagedConnectionsError) {
      throw mockGetManagedConnectionsError;
    }
    return [
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
        database: TEST_DB_PATH,
        environment: "local",
      },
      {
        id: "demo-sqlite-memory",
        name: "Demo SQLite Memory",
        type: "sqlite",
        database: ":memory:",
        environment: "local",
      },
    ];
  }),
}));

import { GET, POST } from "@/app/api/mcp/route";
import { McpConnectionContext } from "@/lib/mcp/context";
import { McpDispatcher } from "@/lib/mcp/dispatcher";
import { logger } from "@/lib/logger";
import { getServerAuditBuffer } from "@/lib/audit";
import { consumeRateLimit, clearRateLimitState } from "@/lib/api/rate-limit";

describe("MCP Next.js Route Integration (/api/mcp)", () => {
  beforeAll(() => {
    setupTestDatabase();
  });

  afterAll(async () => {
    await cleanupTestDatabase();
  });

  beforeEach(async () => {
    mockSessionResult = { role: "admin", username: "admin" };
    mockGetManagedConnectionsError = null;
    await McpConnectionContext.resetGlobalCache();
    getServerAuditBuffer().clear();
    clearRateLimitState();
  });

  test("GET /api/mcp responds 200 with MCP protocol metadata", async () => {
    const response = await GET();
    expect(response.status).toBe(200);

    const body = await parseResponseJSON<any>(response);
    expect(body.status).toBe("ok");
    expect(body.protocol).toBe("mcp");
    expect(body.protocolVersion).toBe("2024-11-05");
    expect(body.server).toBe("libredb-studio-mcp");
  });

  test("POST /api/mcp rejects unauthenticated request with status 401 from guardRoute", async () => {
    mockSessionResult = null;
    const req = createMockRequest("/api/mcp", {
      method: "POST",
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });

    const response = await POST(req as any);
    expect(response.status).toBe(401);

    const body = await parseResponseJSON<any>(response);
    expect(body.error).toBe("Authentication required");
  });

  test("POST /api/mcp ignores external token headers and requires valid LibreDB session", async () => {
    mockSessionResult = null;

    const req = createMockRequest("/api/mcp", {
      method: "POST",
      headers: {
        "x-libredb-mcp-token": "arbitrary-token",
        Authorization: "Bearer arbitrary-token",
      },
      body: { jsonrpc: "2.0", id: 10, method: "ping" },
    });

    const response = await POST(req as any);
    expect(response.status).toBe(401);

    const body = await parseResponseJSON<any>(response);
    expect(body.error).toBe("Authentication required");
  });

  test("POST /api/mcp accepts request with authenticated user session", async () => {
    mockSessionResult = { role: "user", username: "regular_user" };

    const req = createMockRequest("/api/mcp", {
      method: "POST",
      body: { jsonrpc: "2.0", id: 11, method: "ping" },
    });

    const response = await POST(req as any);
    expect(response.status).toBe(200);

    const body = await parseResponseJSON<any>(response);
    expect(body.id).toBe(11);
    expect(body.result).toEqual({});
  });

  test("POST /api/mcp executes 'initialize' handshake successfully", async () => {
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

  test("POST /api/mcp lists tools with 'tools/list'", async () => {
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

  test("POST /api/mcp executes 'tools/call' for 'list_connections'", async () => {
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
    expect(data.length).toBe(3);
    expect(data.some((c: any) => c.id === "demo-pg")).toBe(true);
    expect(data.some((c: any) => c.id === "demo-sqlite")).toBe(true);
  });

  test("POST /api/mcp executes 'tools/call' for 'run_read_query' successfully with pagination", async () => {
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

  test("POST /api/mcp refuses profile for SQLite :memory: without fallback to writable provider", async () => {
    const req = createMockRequest("/api/mcp", {
      method: "POST",
      body: {
        jsonrpc: "2.0",
        id: "refuse-memory-1",
        method: "tools/call",
        params: {
          name: "run_read_query",
          arguments: {
            connection_id: "demo-sqlite-memory",
            sql: "SELECT 1",
          },
        },
      },
    });

    const response = await POST(req as any);
    expect(response.status).toBe(200);

    const body = await parseResponseJSON<any>(response);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("cannot target an in-memory SQLite database");
  });

  test("POST /api/mcp refuses inspect_schema on SQLite :memory: without fallback", async () => {
    const req = createMockRequest("/api/mcp", {
      method: "POST",
      body: {
        jsonrpc: "2.0",
        id: "refuse-inspect-1",
        method: "tools/call",
        params: {
          name: "inspect_schema",
          arguments: {
            connection_id: "demo-sqlite-memory",
          },
        },
      },
    });

    const response = await POST(req as any);
    expect(response.status).toBe(200);

    const body = await parseResponseJSON<any>(response);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("cannot target an in-memory SQLite database");
  });

  test("POST /api/mcp rejects destructive statement in 'run_read_query' with isError: true", async () => {
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

  test("POST /api/mcp executes 'tools/call' for 'inspect_schema'", async () => {
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

  test("POST /api/mcp responds 204 for notifications without body", async () => {
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

  test("POST /api/mcp cancels cross-request query via notifications/cancelled notification", async () => {
    const mockAsyncProvider = {
      readOnlyProfile: true,
      prepareQuery: (sql: string, opts: any) => ({ query: sql, limit: opts.limit, offset: 0, wasLimited: false }),
      queryReadOnly: async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { rows: [{ val: 1 }], fields: ["val"] };
      },
    };

    McpConnectionContext.setCachedProvider("demo-sqlite", "agent-read-only", mockAsyncProvider as any);

    // Fire POST 1 with long-running query
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

    // Wait 20ms to ensure query started in provider
    await new Promise((r) => setTimeout(r, 20));

    // Fire POST 2 with cancellation notification for requestId "slow-query-1"
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

  test("POST /api/mcp responds 400 on invalid or malformed JSON", async () => {
    const brokenReq = {
      method: "POST",
      headers: new Headers(),
      json: async () => {
        throw new Error("Unexpected token at position 0");
      },
    };
    const response = await POST(brokenReq as any);
    expect(response.status).toBe(400);
    const body = await parseResponseJSON<any>(response);
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(-32700);
    expect(body.error.message).toContain("Parse error");
  });

  test("POST /api/mcp catches error in getManagedConnections and proceeds with empty connections", async () => {
    const secret = "synthetic_managed_connection_secret";
    mockGetManagedConnectionsError = new Error(`Simulated managed connections failure: password=${secret}`);
    const warnings: Array<{ message: string; context: any }> = [];
    const warnSpy = spyOn(logger, "warn").mockImplementation((message, context) => {
      warnings.push({ message, context });
    });
    const req = createMockRequest("/api/mcp", {
      method: "POST",
      body: { jsonrpc: "2.0", id: "ping-fallback", method: "ping" },
    });
    try {
      const response = await POST(req as any);
      expect(response.status).toBe(200);
      const body = await parseResponseJSON<any>(response);
      expect(body.id).toBe("ping-fallback");
      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toBe("Could not load managed connections for MCP session");
      expect(warnings[0].context.role).toBe("admin");
      expect(warnings[0].context.error).toBeInstanceOf(Error);
      expect(warnings[0].context.error).not.toBe(mockGetManagedConnectionsError);
      expect(warnings[0].context.error.message).toContain("password=[REDACTED]");
      expect(warnings[0].context.error.message).not.toContain(secret);
      expect(warnings[0].context.error.stack ?? "").not.toContain(secret);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("POST /api/mcp responds 500 when unhandled error occurs in dispatcher", async () => {
    const originalHandle = McpDispatcher.prototype.handle;
    McpDispatcher.prototype.handle = async () => {
      throw new Error("Dispatcher fatal explosion");
    };

    try {
      const req = createMockRequest("/api/mcp", {
        method: "POST",
        body: { jsonrpc: "2.0", id: "crash-1", method: "ping" },
      });
      const response = await POST(req as any);
      expect(response.status).toBe(500);
      const body = await parseResponseJSON<any>(response);
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32603);
      expect(body.error.message).toBe("Dispatcher fatal explosion");
    } finally {
      McpDispatcher.prototype.handle = originalHandle;
    }
  });

  test("POST /api/mcp emits audit event when run_read_query reaches engine", async () => {
    getServerAuditBuffer().clear();

    const req = createMockRequest("/api/mcp", {
      method: "POST",
      body: {
        jsonrpc: "2.0",
        id: "audit-query-1",
        method: "tools/call",
        params: {
          name: "run_read_query",
          arguments: {
            connection_id: "demo-sqlite",
            sql: "SELECT 100 AS num",
          },
        },
      },
    });

    const response = await POST(req as any);
    expect(response.status).toBe(200);

    const auditEvents = getServerAuditBuffer().filter({ type: "agent_operation" });
    expect(auditEvents.length).toBeGreaterThan(0);
    const queryEvent = auditEvents.find((e) => e.action === "run_read_query" && e.target === "demo-sqlite");
    expect(queryEvent).toBeDefined();
    expect(queryEvent?.user).toBe("admin");
    expect(queryEvent?.result).toBe("success");
    expect(queryEvent?.duration).toBeDefined();
    expect(queryEvent?.correlationId).toBe("audit-query-1");
  });

  test("POST /api/mcp emits audit event when inspect_schema reaches engine", async () => {
    getServerAuditBuffer().clear();

    const req = createMockRequest("/api/mcp", {
      method: "POST",
      body: {
        jsonrpc: "2.0",
        id: "audit-schema-1",
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

    const auditEvents = getServerAuditBuffer().filter({ type: "agent_operation" });
    expect(auditEvents.length).toBeGreaterThan(0);
    const schemaEvent = auditEvents.find((e) => e.action === "inspect_schema" && e.target === "demo-sqlite");
    expect(schemaEvent).toBeDefined();
    expect(schemaEvent?.user).toBe("admin");
    expect(schemaEvent?.result).toBe("success");
    expect(schemaEvent?.duration).toBeDefined();
    expect(schemaEvent?.correlationId).toBe("audit-schema-1");
  });

  test("POST /api/mcp meters batch database calls against query bucket and throttles with 429 when exhausted", async () => {
    clearRateLimitState();
    getServerAuditBuffer().clear();

    // Consume 119 out of 120 slots on query bucket for "admin"
    for (let i = 0; i < 119; i++) {
      consumeRateLimit("query", "admin");
    }

    // Now 1 slot remains. Send a batch with 2 database queries:
    // 1st query uses the last slot, 2nd query exceeds query budget -> 429
    const req = createMockRequest("/api/mcp", {
      method: "POST",
      body: [
        {
          jsonrpc: "2.0",
          id: "batch-query-1",
          method: "tools/call",
          params: {
            name: "run_read_query",
            arguments: { connection_id: "demo-sqlite", sql: "SELECT 1" },
          },
        },
        {
          jsonrpc: "2.0",
          id: "batch-query-2",
          method: "tools/call",
          params: {
            name: "run_read_query",
            arguments: { connection_id: "demo-sqlite", sql: "SELECT 2" },
          },
        },
      ],
    });

    const response = await POST(req as any);
    expect(response.status).toBe(429);

    const throttledEvents = getServerAuditBuffer().filter({ type: "rate_limit_exceeded" });
    expect(throttledEvents.length).toBeGreaterThan(0);
    expect(throttledEvents[0].bucket).toBe("query");
    expect(throttledEvents[0].user).toBe("admin");
  });

  test("POST /api/mcp allows batch database calls when within rate limit budget", async () => {
    clearRateLimitState();
    const req = createMockRequest("/api/mcp", {
      method: "POST",
      body: [
        {
          jsonrpc: "2.0",
          id: "batch-allowed-1",
          method: "tools/call",
          params: {
            name: "run_read_query",
            arguments: { connection_id: "demo-sqlite", sql: "SELECT 1" },
          },
        },
        {
          jsonrpc: "2.0",
          id: "batch-allowed-2",
          method: "tools/call",
          params: {
            name: "run_read_query",
            arguments: { connection_id: "demo-sqlite", sql: "SELECT 2" },
          },
        },
      ],
    });

    const response = await POST(req as any);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(2);
  });
});
