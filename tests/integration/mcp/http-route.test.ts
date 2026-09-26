/**
 * POST, GET and DELETE /api/mcp through the route module (#246), driven by the official SDK
 * client in process.
 *
 * The route still admits a Studio session here, which this file provides by replacing
 * getSession alone; every other export of @/lib/auth is the real one.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realAuth from "@/lib/auth";
import {
  createDuckdbFile,
  createSqliteFile,
  gateMethod,
  pinMcpTestEnvironment,
  resetMcpTestState,
  writeSeedFile,
} from "../../helpers/mcp-fixtures";
import { connectClient, legacyPost, readJsonRpc, routeServe } from "../../helpers/mcp-harness";

pinMcpTestEnvironment();

const mockGetSession = mock(async (): Promise<realAuth.UserPayload | null> => ({ username: "alice", role: "admin" }));
mock.module("@/lib/auth", () => ({ ...realAuth, getSession: mockGetSession }));

const route = await import("@/app/api/mcp/route");
const { DuckDBProvider } = await import("@/lib/db/providers/sql/duckdb");
const { getServerAuditBuffer } = await import("@/lib/audit");
const serve = routeServe(route);
const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-route-"));

beforeAll(async () => {
  createSqliteFile(join(dir, "shop.db"), [
    "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)",
    "INSERT INTO users VALUES (1, 'Ada'), (2, 'Grace')",
  ]);
  await createDuckdbFile(join(dir, "slow.duckdb"), [
    "CREATE TABLE answers (answer INTEGER)",
    "INSERT INTO answers VALUES (42)",
  ]);
});

beforeEach(() => {
  mockGetSession.mockImplementation(async () => ({ username: "alice", role: "admin" }));
  writeSeedFile(dir, [
    { id: "shop", type: "sqlite", database: join(dir, "shop.db") },
    { id: "slow", type: "duckdb", database: join(dir, "slow.duckdb") },
  ]);
});

afterEach(async () => {
  await resetMcpTestState();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("a cancel sent in its own POST", () => {
  test("does not stop the call it names, because the SDK serves every POST on a server of its own", async () => {
    const gate = gateMethod(DuckDBProvider.prototype, "queryReadOnly");
    try {
      const call = serve(
        legacyPost({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: {
            name: "run_read_query",
            arguments: { connection_id: "seed:slow", sql: "SELECT answer FROM answers" },
          },
        }),
      );
      await gate.entered;
      const cancel = await serve(
        legacyPost({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: 7, reason: "stopped by the test" },
        }),
      );
      expect(cancel.status).toBe(202);

      gate.release();
      const reply = await readJsonRpc(await call);
      expect(reply.result?.isError ?? false).toBe(false);
      expect(JSON.stringify(reply.result?.content)).toContain("42");
    } finally {
      gate.release();
      // The held statement runs to its end before afterEach closes the provider under it.
      await gate.finished;
      gate.restore();
    }
  });
});

describe("a client pinned to revision 2026-07-28", () => {
  test("discovers the server, connects in the modern era and calls a tool", async () => {
    const session = await connectClient(serve, { negotiation: "pinned" });
    try {
      expect(session.client.getProtocolEra()).toBe("modern");
      const result = await session.client.callTool({ name: "list_connections", arguments: {} });
      expect(JSON.stringify(result.content)).toContain("seed:shop");
    } finally {
      await session.close();
    }
  });
});

describe("the route in front of the SDK", () => {
  test("lets the default client connect and list the three tools", async () => {
    const session = await connectClient(serve);
    try {
      expect((await session.client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "list_connections",
        "inspect_schema",
        "run_read_query",
      ]);
    } finally {
      await session.close();
    }
  });

  test.each(["GET", "DELETE"])("answers %s with the SDK's 405 and Allow: POST", async (method) => {
    const response = await serve(
      new Request("http://localhost:3000/api/mcp", { method, headers: { host: "localhost:3000" } }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  test("answers a legacy notification with 202, not 204", async () => {
    const response = await serve(legacyPost({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(response.status).toBe(202);
  });

  test("keeps guardRoute's 401 for a POST without a session at this stage", async () => {
    mockGetSession.mockImplementation(async () => null);
    const response = await serve(legacyPost({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Authentication required" });
  });

  test("hands the session's user to the tools as their caller", async () => {
    const session = await connectClient(serve);
    try {
      await session.client.callTool({
        name: "run_read_query",
        arguments: { connection_id: "seed:shop", sql: "SELECT id FROM users" },
      });
      const users = getServerAuditBuffer()
        .getAll()
        .filter((event) => event.action === "run_read_query")
        .map((event) => event.user);
      // At least one event, and every one names the caller, however many events the tool writes
      // for one call.
      expect([...new Set(users)]).toEqual(["alice"]);
    } finally {
      await session.close();
    }
  });
});
