import { describe, expect, test } from "bun:test";
import type { McpConnectionContext } from "@/lib/mcp/context";
import { McpDispatcher } from "@/lib/mcp/dispatcher";
import { McpCancellationManager } from "@/lib/mcp/guards/cancellation";
import { checkReadOnlyStatement } from "@/lib/mcp/guards/execution-fence";
import { redactErrorMessage, safeJsonStringify } from "@/lib/mcp/serializer";
import { executeRunReadQuery } from "@/lib/mcp/tools/run-read-query";
import { executeListConnections } from "@/lib/mcp/tools/list-connections";
import { executeInspectSchema } from "@/lib/mcp/tools/inspect-schema";
import type { JsonRpcResponse } from "@/lib/mcp/types";

// Deliberately no mock.module: this file must not poison the existing route tests.
const LIMIT = 64 * 1024;
const args = { connection_id: "stress", sql: "SELECT 1", timeout_ms: 500 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function contextFor(provider: object): McpConnectionContext {
  return { getProvider: async () => provider } as unknown as McpConnectionContext;
}
function rowsContext(rows: unknown[], fields: string[] = ["value"]) {
  return contextFor({
    readOnlyProfile: true,
    prepareQuery: (sql: string, options: { limit: number }) => ({
      query: sql,
      limit: options.limit,
      offset: 0,
      wasLimited: false,
    }),
    queryReadOnly: async () => ({ rows, fields }),
  });
}
const rpc = (id: string | number = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "run_read_query", arguments: args },
});

describe("Codex adversarial: cancellation isolation and lifecycle", () => {
  test("64 hostile callers, asynchronous native cancellation and late notifications", async () => {
    const manager = new McpCancellationManager();
    const callers = Array.from({ length: 64 }, (_, i) => `user:${i}\0\n"[{}]`);
    let nativeCalls = 0;
    const signals = callers.map((caller) =>
      manager.register(caller, "same:id", "stress", async () => {
        await Promise.resolve();
        nativeCalls++;
      }),
    );
    await Promise.all(
      callers.map(async (caller, i) => {
        if (i % 2 === 0) expect(await manager.handleCancellation(caller, "same:id")).toBe(true);
        else manager.deregister(caller, "same:id");
      }),
    );
    expect(nativeCalls).toBe(32);
    signals.forEach((signal, i) => expect(signal.aborted).toBe(i % 2 === 0));
    for (const caller of callers) expect(await manager.handleCancellation(caller, "same:id")).toBe(false);
  });

  test("separator injection does not cross caller boundaries", async () => {
    const manager = new McpCancellationManager();
    const a = manager.register("alice:ops", "query", "stress");
    const b = manager.register("alice", "ops:query", "stress");
    await manager.handleCancellation("alice", "ops:query");
    expect(a.aborted).toBe(false);
    expect(b.aborted).toBe(true);
    await manager.abortAll();
  });

  test("unknown early cancellation is ignored; completed operations stay deregistered", async () => {
    const manager = new McpCancellationManager();
    expect(await manager.handleCancellation("a", 1)).toBe(false);
    const signal = manager.register("a", 1, "stress");
    expect(signal.aborted).toBe(false);
    manager.deregister("a", 1);
    expect(await manager.handleCancellation("a", 1)).toBe(false);
  });

  test("numeric and string request IDs must remain distinct", async () => {
    const manager = new McpCancellationManager();
    const number = manager.register("a", 1, "stress");
    const string = manager.register("a", "1", "stress");
    await manager.handleCancellation("a", 1);
    expect(number.aborted).toBe(true);
    expect(string.aborted).toBe(false);
  });

  test("late native cancellation completion must not delete a replacement handle", async () => {
    const manager = new McpCancellationManager();
    const gate = deferred<void>();
    manager.register("a", "id", "stress", () => gate.promise);
    const cancelling = manager.handleCancellation("a", "id");
    manager.deregister("a", "id");
    const replacement = manager.register("a", "id", "stress");
    gate.resolve();
    await cancelling;
    expect(await manager.handleCancellation("a", "id")).toBe(true);
    expect(replacement.aborted).toBe(true);
  });

  test("notification must finish even while native cancellation is pending", async () => {
    const manager = new McpCancellationManager();
    const gate = deferred<void>();
    manager.register("a", "slow", "stress", () => gate.promise);
    const dispatcher = new McpDispatcher(rowsContext([]), manager);
    const notification = dispatcher.handle(
      { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "slow" } },
      { callerId: "a" },
    );
    let timer: ReturnType<typeof setTimeout>;
    const outcome = await Promise.race([
      notification.then(() => "finished"),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("blocked"), 40);
      }),
    ]);
    gate.resolve();
    await notification;
    clearTimeout(timer!);
    expect(outcome).toBe("finished");
  });

  test("cancellation while provider acquisition is pending must prevent query start", async () => {
    const manager = new McpCancellationManager();
    const acquiring = deferred<void>();
    const provider = deferred<object>();
    let executions = 0;
    const context = {
      getProvider: () => {
        acquiring.resolve();
        return provider.promise;
      },
    } as unknown as McpConnectionContext;
    const dispatcher = new McpDispatcher(context, manager);
    const running = dispatcher.handle(rpc("pending"), { callerId: "a" });
    await acquiring.promise;
    await dispatcher.handle(
      { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "pending" } },
      { callerId: "a" },
    );
    provider.resolve({
      readOnlyProfile: true,
      queryReadOnly: async () => {
        executions++;
        return { rows: [] };
      },
    });
    await running;
    expect(executions).toBe(0);
  });

  test("request IDs x and mcp_x must not alias different live operations", async () => {
    const manager = new McpCancellationManager();
    const started = deferred<void>();
    const finish = deferred<{ rows: unknown[] }>();
    let starts = 0;
    const dispatcher = new McpDispatcher(
      contextFor({
        readOnlyProfile: true,
        queryReadOnly: () => {
          if (++starts === 2) started.resolve();
          return finish.promise;
        },
      }),
      manager,
    );
    const first = dispatcher.handle(rpc("x"), { callerId: "a" });
    const second = dispatcher.handle(rpc("mcp_x"), { callerId: "a" });
    await started.promise;
    await dispatcher.handle(
      { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "x" } },
      { callerId: "a" },
    );
    finish.resolve({ rows: [] });
    const results = (await Promise.all([first, second])) as Array<JsonRpcResponse>;
    expect((results[0].result as { isError?: boolean }).isError).toBe(true);
    expect((results[1].result as { isError?: boolean }).isError).not.toBe(true);
  });

  test("AbortSignal listener must be removed after normal completion", async () => {
    const controller = new AbortController();
    const manager = new McpCancellationManager();
    await executeRunReadQuery(args, rowsContext([]), {
      requestId: "reuse",
      callerId: "a",
      signal: controller.signal,
      cancellationManager: manager,
    });
    const replacement = manager.register("a", "mcp_reuse", "stress");
    controller.abort();
    expect(replacement.aborted).toBe(false);
  });
});

describe("Codex adversarial: execution fence and fail closed", () => {
  for (const sql of [
    "WITH deleted AS (DELETE FROM users RETURNING *) SELECT * FROM deleted",
    "WITH x AS (INSERT INTO users VALUES (1) RETURNING *) SELECT * FROM x",
    "WITH x AS (UPDATE users SET name='x' RETURNING *) SELECT * FROM x",
    "SELECT 1; /* harmless */ DROP TABLE users",
    "SELECT ';';\nDELETE FROM users",
    "SELECT 1\0; DELETE FROM users",
    "\u000bDELETE\u000cFROM users",
    "DE\u200bLETE FROM users",
    "BEGIN",
    "COMMIT",
    "ROLLBACK",
    "SELECT 1 INTO stolen",
    "SELECT /* outer /* inner */ DELETE */ 1",
    "SELECT 'unterminated; DROP TABLE users",
  ])
    test(`refuses ${JSON.stringify(sql)}`, () => expect(checkReadOnlyStatement(sql)).not.toBeNull());

  for (const sql of [
    "SELECT '; DELETE FROM users' AS value",
    "SELECT /* comment /* nested */ */ 1",
    "SELECT 1; -- done",
    "WITH x AS (SELECT 1) SELECT * FROM x",
  ])
    test(`allows harmless literal/comment ${JSON.stringify(sql)}`, () =>
      expect(checkReadOnlyStatement(sql)).toBeNull());

  for (const profile of [undefined, false, "true", 1])
    test(`no writable fallback: profile=${profile}`, async () => {
      let calls = 0;
      const result = await executeRunReadQuery(
        args,
        contextFor({
          readOnlyProfile: profile,
          query: () => {
            calls++;
          },
          queryReadOnly: () => {
            calls++;
          },
        }),
      );
      expect(result.isError).toBe(true);
      expect(calls).toBe(0);
    });
  test("missing queryReadOnly never calls query", async () => {
    let calls = 0;
    const result = await executeRunReadQuery(
      args,
      contextFor({
        readOnlyProfile: true,
        query: () => {
          calls++;
        },
      }),
    );
    expect(result.isError).toBe(true);
    expect(calls).toBe(0);
  });
});

describe("Codex adversarial: actual serialized response budget", () => {
  for (const [label, rows, fields] of [
    [
      "20,000 UTF-8 rows",
      Array.from({ length: 20000 }, (_, i) => ({ i, value: "😀漢字".repeat(100) })),
      ["i", "value"],
    ],
    [
      "20,000 columns",
      [Object.fromEntries(Array.from({ length: 20000 }, (_, i) => [`c${i}`, "😀漢字".repeat(20)]))],
      Array.from({ length: 20000 }, (_, i) => `c${i}`),
    ],
    ["JSON escaping near boundary", [{ value: '"'.repeat(32000) }], ["value"]],
  ] as Array<[string, unknown[], string[]]>)
    test(label, async () => {
      const response = (await new McpDispatcher(rowsContext(rows, fields)).handle(rpc())) as JsonRpcResponse;
      const result = response.result as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).not.toBe(true);
      const inner = result.content[0].text;
      const envelope = JSON.parse(inner);
      const innerBytes = Buffer.byteLength(inner);
      const wireBytes = Buffer.byteLength(JSON.stringify(response));
      console.info(`[codex-stress] ${label}: inner=${innerBytes} wire=${wireBytes} rows=${envelope.row_count}`);
      expect(envelope.byte_size).toBe(innerBytes);
      expect(innerBytes).toBeLessThanOrEqual(LIMIT);
      // Explicit fixed tolerance for JSON-RPC metadata, never proportional to attacker input.
      expect(wireBytes).toBeLessThanOrEqual(LIMIT + 1024);
    });

  test("depth 32, cycles, BigInt and binary data remain serializable", async () => {
    const root: Record<string, unknown> = { bigint: BigInt("9223372036854775807"), bytes: Buffer.alloc(16) };
    let cursor = root;
    for (let i = 0; i < 32; i++) {
      const next = {};
      cursor.next = next;
      cursor = next;
    }
    cursor.cycle = root;
    const result = await executeRunReadQuery(args, rowsContext([{ value: root }]));
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain("[Circular]");
    expect(result.content[0].text).toContain("9223372036854775807");
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(LIMIT + 1024);
  });

  test("50 response batch must respect aggregate HTTP budget", async () => {
    const dispatcher = new McpDispatcher(rowsContext([{ value: "a".repeat(20000) }]));
    const response = await dispatcher.handle(Array.from({ length: 50 }, (_, i) => rpc(i)));
    const bytes = Buffer.byteLength(JSON.stringify(response));
    console.info(`[codex-stress] 50-result batch wire=${bytes}`);
    expect(bytes).toBeLessThanOrEqual(LIMIT + 1024);
  });

  test("large JSON-RPC id cannot bypass response cap", async () => {
    const response = await new McpDispatcher(rowsContext([])).handle({
      jsonrpc: "2.0",
      id: "x".repeat(100000),
      method: "ping",
    });
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(LIMIT + 1024);
  });

  test("inspect_schema column metadata must also be bounded", async () => {
    const result = await executeInspectSchema(
      { connection_id: "stress" },
      contextFor({
        listContainers: async () => [{ name: "public", path: [] }],
        listObjects: async () => [{ name: "wide", path: ["wide"] }],
        describeObject: async () => ({
          columns: Array.from({ length: 20000 }, (_, i) => ({ name: `col${i}`, type: "text" })),
        }),
      }),
    );
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(LIMIT + 1024);
  });
});

describe("Codex adversarial: JSON-RPC protocol", () => {
  const dispatcher = () => new McpDispatcher(rowsContext([]));
  test("rejects 51 requests before executing the batch", async () => {
    const response = (await dispatcher().handle(
      Array.from({ length: 51 }, (_, id) => ({ jsonrpc: "2.0", id, method: "ping" })),
    )) as JsonRpcResponse;
    expect(response.error?.code).toBe(-32600);
  });
  test("mixed primitive batch members get individual invalid-request errors", async () => {
    const response = (await dispatcher().handle([
      42,
      true,
      [],
      null,
      "text",
      { jsonrpc: "2.0", id: 1, method: "ping" },
    ])) as JsonRpcResponse[];
    expect(response).toHaveLength(6);
    response.slice(0, 5).forEach((r) => {
      expect(r.error?.code).toBe(-32600);
      expect(r.id).toBeNull();
    });
    expect(response[5].result).toEqual({});
  });
  for (const id of [1.25, NaN, {}, [], null])
    test(`rejects invalid MCP id ${JSON.stringify(id)}`, async () => {
      // NaN is an in-process robustness probe: it cannot occur literally in JSON on the wire.
      const response = (await dispatcher().handle({ jsonrpc: "2.0", id, method: "ping" })) as JsonRpcResponse;
      expect(response.id).toBeNull();
      expect(response.error?.code).toBe(-32600);
    });
  test("malformed method plus object id must not reflect invalid id", async () => {
    const response = (await dispatcher().handle({ jsonrpc: "2.0", id: { secret: "synthetic" } })) as JsonRpcResponse;
    expect(response.error?.code).toBe(-32600);
    expect(response.id).toBeNull();
  });
  test("missing method without id is invalid, not a valid notification", async () => {
    const response = (await dispatcher().handle({ jsonrpc: "2.0" })) as JsonRpcResponse;
    expect(response.error?.code).toBe(-32600);
  });
  test("notification-only batch returns no response", async () => {
    expect(
      await dispatcher().handle([
        { jsonrpc: "2.0", method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
      ]),
    ).toBeNull();
  });
  test("primitive params are invalid even for ping", async () => {
    const response = (await dispatcher().handle({
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
      params: 42,
    })) as JsonRpcResponse;
    expect(response.error?.code).toBe(-32602);
  });
});

describe("Codex adversarial: synthetic credential redaction", () => {
  for (const [message, secrets] of [
    [
      "Failed connecting to postgres://user:s3cr3t_p@ss!@db.internal:5432/production?ssl=true&token=tok_998877&api_key=key_xyz123",
      ["s3cr3t_p", "ss!", "tok_998877", "key_xyz123"],
    ],
    ['password="synthetic secret with spaces" token=tok_demo', ["synthetic", "secret with spaces", "tok_demo"]],
    [
      '{"password":"synthetic_json_secret","token":"synthetic_json_token"}',
      ["synthetic_json_secret", "synthetic_json_token"],
    ],
    ["Authorization: Bearer synthetic_bearer_secret", ["synthetic_bearer_secret"]],
    ["Password=synthetic_password;api_key=synthetic_key", ["synthetic_password", "synthetic_key"]],
  ] as Array<[string, string[]]>)
    test(`redacts ${message.split(":")[0]}`, () => {
      const result = redactErrorMessage(message);
      for (const secret of secrets) expect(result).not.toContain(secret);
    });
  test("list_connections errors use redaction too", async () => {
    const context = {
      listPublicConnections: () => {
        throw new Error("password=synthetic_list_secret");
      },
    } as unknown as McpConnectionContext;
    const result = await executeListConnections({}, context);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("synthetic_list_secret");
  });
  test("already aborted request reasons are redacted", async () => {
    const controller = new AbortController();
    controller.abort("token=synthetic_abort_secret");
    const result = await executeRunReadQuery(args, rowsContext([]), { signal: controller.signal });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("synthetic_abort_secret");
  });
  test("shared JSON object is not mislabeled as a cycle", () => {
    const shared = { value: 1 };
    expect(JSON.parse(safeJsonStringify({ a: shared, b: shared }))).toEqual({ a: { value: 1 }, b: { value: 1 } });
  });
});
