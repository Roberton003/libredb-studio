/**
 * POST, GET and DELETE /api/mcp through the route module (#246), driven by the official SDK
 * client in process.
 *
 * Every request carries a scoped bearer token minted at run time; the Studio session opens nothing here.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signJWT } from "@/lib/auth";
import { logger } from "@/lib/logger";
import {
  countMethod,
  createDuckdbFile,
  createSqliteFile,
  gateMethod,
  pinMcpTestEnvironment,
  resetMcpTestState,
  writeSeedFile,
} from "../../helpers/mcp-fixtures";
import { connectClient, legacyPost, MCP_TEST_URL, readJsonRpc, routeServe } from "../../helpers/mcp-harness";
import { mintTestToken, useMcpChannel } from "../../helpers/mcp-token";

pinMcpTestEnvironment();

const route = await import("@/app/api/mcp/route");
const { DuckDBProvider } = await import("@/lib/db/providers/sql/duckdb");
const { SQLiteProvider } = await import("@/lib/db/providers/sql/sqlite");
const { getServerAuditBuffer } = await import("@/lib/audit");
const serve = routeServe(route);
const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-route-"));

let restoreChannel: () => void = () => {};
let token = "";

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

beforeEach(async () => {
  restoreChannel = useMcpChannel();
  token = await mintTestToken();
  writeSeedFile(dir, [
    { id: "shop", type: "sqlite", database: join(dir, "shop.db") },
    { id: "slow", type: "duckdb", database: join(dir, "slow.duckdb") },
  ]);
});

afterEach(async () => {
  restoreChannel();
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
        legacyPost(
          {
            jsonrpc: "2.0",
            id: 7,
            method: "tools/call",
            params: {
              name: "run_read_query",
              arguments: { connection_id: "seed:slow", sql: "SELECT answer FROM answers" },
            },
          },
          { token },
        ),
      );
      await gate.entered;
      const cancel = await serve(
        legacyPost(
          {
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: 7, reason: "stopped by the test" },
          },
          { token },
        ),
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
    const session = await connectClient(serve, { negotiation: "pinned", token });
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
    const session = await connectClient(serve, { token });
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
      new Request("http://localhost:3000/api/mcp", {
        method,
        headers: { host: "localhost:3000", authorization: `Bearer ${token}` },
      }),
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
    const response = await serve(legacyPost({ jsonrpc: "2.0", method: "notifications/initialized" }, { token }));
    expect(response.status).toBe(202);
  });

  test("answers 401 with the bearer challenge for a POST without a token, and for a random one", async () => {
    for (const options of [{}, { token: "random-bearer-written-in-words" }]) {
      const response = await serve(legacyPost({ jsonrpc: "2.0", id: 1, method: "tools/list" }, options));
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toStartWith('Bearer error="invalid_token"');
      expect(((await response.json()) as { error: string }).error).toBe("invalid_token");
    }
  });

  test("hands the token's user to the tools as their caller", async () => {
    const session = await connectClient(serve, { token });
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

describe("the session cookie opens nothing on /api/mcp", () => {
  const runQuery = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "run_read_query", arguments: { connection_id: "seed:shop", sql: "SELECT id FROM users" } },
  };

  test("a valid session cookie without a bearer gets 401 and constructs no provider", async () => {
    const connects = countMethod(SQLiteProvider.prototype, "connect");
    try {
      const cookie = await signJWT({ username: "alice", role: "admin" });
      const response = await serve(legacyPost(runQuery, { headers: { cookie: `auth-token=${cookie}` } }));
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toStartWith('Bearer error="invalid_token"');
      expect(connects.calls).toBe(0);
    } finally {
      connects.restore();
    }
  });

  test("one user's cookie with another user's token acts as the token's user", async () => {
    const cookie = await signJWT({ username: "alice", role: "admin" });
    const bobToken = await mintTestToken({ username: "bob", role: "user" });
    await readJsonRpc(
      await serve(legacyPost(runQuery, { token: bobToken, headers: { cookie: `auth-token=${cookie}` } })),
    );
    const users = getServerAuditBuffer()
      .getAll()
      .filter((event) => event.action === "run_read_query")
      .map((event) => event.user);
    expect([...new Set(users)]).toEqual(["bob"]);
  });
});

describe("the server version, checked after the kill switch", () => {
  test("unset answers an authenticated request with 500 naming the variable, and a request without a token with 401", async () => {
    const saved = process.env.NEXT_PUBLIC_APP_VERSION;
    delete process.env.NEXT_PUBLIC_APP_VERSION;
    const errorLog = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const response = await serve(legacyPost({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token }));
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "server version unavailable: NEXT_PUBLIC_APP_VERSION is not set",
      });
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect((await serve(legacyPost({ jsonrpc: "2.0", id: 2, method: "tools/list" }))).status).toBe(401);
      restoreChannel();
      restoreChannel = useMcpChannel({ enabled: "off" });
      expect((await serve(legacyPost({ jsonrpc: "2.0", id: 3, method: "tools/list" }, { token }))).status).toBe(404);
    } finally {
      process.env.NEXT_PUBLIC_APP_VERSION = saved;
      errorLog.mockRestore();
    }
  });
});

describe("the query budget at the route", () => {
  afterEach(() => {
    delete process.env.RATE_LIMIT_QUERY_MAX;
  });

  test("initialize, tools/list, a ping, a list_connections call and a notification each spend one slot", async () => {
    process.env.RATE_LIMIT_QUERY_MAX = "5";
    const bodies = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "budget-test", version: "1.0.0" },
        },
      },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "ping" },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_connections", arguments: {} } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ];
    for (const body of bodies) {
      const response = await serve(legacyPost(body, { token }));
      expect(response.status).not.toBe(429);
      await response.text();
    }
    expect((await serve(legacyPost({ jsonrpc: "2.0", id: 6, method: "tools/list" }, { token }))).status).toBe(429);
  });

  test("GET and DELETE spend nothing, and are still answered once the budget is spent", async () => {
    process.env.RATE_LIMIT_QUERY_MAX = "1";
    const bodiless = (method: string) =>
      serve(
        new Request(MCP_TEST_URL, { method, headers: { host: "localhost:3000", authorization: `Bearer ${token}` } }),
      );
    for (const method of ["GET", "DELETE", "GET"]) expect((await bodiless(method)).status).toBe(405);
    expect((await serve(legacyPost({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token }))).status).not.toBe(429);
    for (const method of ["GET", "DELETE"]) expect((await bodiless(method)).status).toBe(405);
    expect((await serve(legacyPost({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { token }))).status).toBe(429);
  });
});
