import { describe, expect, test, spyOn } from "bun:test";
import { McpConnectionContext } from "@/lib/mcp/context";
import { McpDispatcher } from "@/lib/mcp/dispatcher";
import { McpCancellationManager } from "@/lib/mcp/guards/cancellation";
import { JSON_RPC_ERRORS } from "@/lib/mcp/types";
import { logger } from "@/lib/logger";
import type { DatabaseConnection } from "@/lib/db/types";

describe("MCP Dispatcher (JSON-RPC 2.0 Engine)", () => {
  const mockConnection: DatabaseConnection = {
    id: "test-conn-1",
    name: "Production PG",
    type: "postgres",
    database: "analytics_db",
    environment: "production",
    createdAt: new Date(),
  };

  const cancellationManager = new McpCancellationManager();
  const context = new McpConnectionContext([mockConnection]);
  const dispatcher = new McpDispatcher(context, cancellationManager);

  test("processes 'initialize' request and returns 2024-11-05 handshake", async () => {
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    };

    const response = (await dispatcher.handle(request)) as any;
    expect(response).toBeDefined();
    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(1);
    expect(response.result).toBeDefined();
    expect(response.result.protocolVersion).toBe("2024-11-05");
    expect(response.result.serverInfo.name).toBe("libredb-studio-mcp");
    expect(response.result.capabilities.tools.listChanged).toBe(false);
  });

  test("returns null for 'notifications/initialized' notification", async () => {
    const notification = {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    };

    const response = await dispatcher.handle(notification);
    expect(response).toBeNull();
  });

  test("processes 'ping' request and returns empty result", async () => {
    const request = {
      jsonrpc: "2.0",
      id: 99,
      method: "ping",
    };

    const response = (await dispatcher.handle(request)) as any;
    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(99);
    expect(response.result).toEqual({});
  });

  test("lists tools with 'tools/list'", async () => {
    const request = {
      jsonrpc: "2.0",
      id: "req-list",
      method: "tools/list",
    };

    const response = (await dispatcher.handle(request)) as any;
    expect(response.id).toBe("req-list");
    expect(response.result.tools).toBeArray();
    expect(response.result.tools.length).toBe(3);

    const toolNames = response.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain("list_connections");
    expect(toolNames).toContain("inspect_schema");
    expect(toolNames).toContain("run_read_query");
  });

  test("executes 'tools/call' for 'list_connections' successfully", async () => {
    const request = {
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: {
        name: "list_connections",
        arguments: { environment: "all" },
      },
    };

    const response = (await dispatcher.handle(request)) as any;
    expect(response.id).toBe(42);
    expect(response.result.content).toBeArray();
    expect(response.result.content[0].type).toBe("text");

    const parsedData = JSON.parse(response.result.content[0].text);
    expect(parsedData).toBeArray();
    expect(parsedData.length).toBe(1);
    expect(parsedData[0].id).toBe("test-conn-1");
    expect(parsedData[0].read_only).toBe(true);
  });

  test("returns isError: true for non-existent tool", async () => {
    const request = {
      jsonrpc: "2.0",
      id: 101,
      method: "tools/call",
      params: {
        name: "drop_database",
        arguments: {},
      },
    };

    const response = (await dispatcher.handle(request)) as any;
    expect(response.id).toBe(101);
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain("Unknown tool");
  });

  test("rejects non-existent method with METHOD_NOT_FOUND (-32601)", async () => {
    const request = {
      jsonrpc: "2.0",
      id: "bad-method",
      method: "unknown_method_xyz",
    };

    const response = (await dispatcher.handle(request)) as any;
    expect(response.id).toBe("bad-method");
    expect(response.error).toBeDefined();
    expect(response.error.code).toBe(JSON_RPC_ERRORS.METHOD_NOT_FOUND);
  });

  test("rejects malformed request with INVALID_REQUEST (-32600)", async () => {
    const request = {
      invalid_jsonrpc: "1.0",
      id: 123,
    };

    const response = (await dispatcher.handle(request)) as any;
    expect(response.error.code).toBe(JSON_RPC_ERRORS.INVALID_REQUEST);
  });

  test("processes batch requests", async () => {
    const batch = [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ];

    const responses = (await dispatcher.handle(batch)) as any[];
    expect(responses).toBeArray();
    expect(responses.length).toBe(2);
    expect(responses[0].id).toBe(1);
    expect(responses[1].id).toBe(2);
  });

  test("rejects invalid IDs (null, float, object) with INVALID_REQUEST (-32600)", async () => {
    const rNull = (await dispatcher.handle({ jsonrpc: "2.0", id: null, method: "ping" })) as any;
    expect(rNull.error.code).toBe(JSON_RPC_ERRORS.INVALID_REQUEST);

    const rFloat = (await dispatcher.handle({ jsonrpc: "2.0", id: 1.5, method: "ping" })) as any;
    expect(rFloat.error.code).toBe(JSON_RPC_ERRORS.INVALID_REQUEST);

    const rObj = (await dispatcher.handle({ jsonrpc: "2.0", id: { bad: true }, method: "ping" })) as any;
    expect(rObj.error.code).toBe(JSON_RPC_ERRORS.INVALID_REQUEST);
  });

  test("rejects batch exceeding 50 request limit with INVALID_REQUEST", async () => {
    const hugeBatch = Array.from({ length: 51 }, (_, i) => ({
      jsonrpc: "2.0",
      id: i + 1,
      method: "ping",
    }));

    const response = (await dispatcher.handle(hugeBatch)) as any;
    expect(response.error.code).toBe(JSON_RPC_ERRORS.INVALID_REQUEST);
    expect(response.error.message).toContain("limit of 50");
  });

  test("processes notifications/cancelled notification calling cancellationManager", async () => {
    let cancelled = false;
    cancellationManager.register("test-user", "test-req-1", "conn-x", async () => {
      cancelled = true;
    });

    const response = await dispatcher.handle(
      {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "test-req-1", reason: "User cancelled" },
      },
      { cancellationManager, callerId: "test-user" },
    );

    expect(response).toBeNull();
    expect(cancelled).toBe(true);
  });

  test("redacts credentials and URIs in internal error messages caught in dispatcher and logger", async () => {
    const syntheticPassword = "dummy_test_password";
    const syntheticToken = "dummy_test_bearer_token";

    const hostileContext = {
      listPublicConnections: () => {
        throw new Error("Simulated connection listing error");
      },
    } as any;

    const loggedErrors: Array<{ msg: string; err: any; ctx?: any }> = [];
    const loggedConsoleMessages: string[] = [];

    const loggerErrorSpy = spyOn(logger, "error").mockImplementation((msg, err, ctx) => {
      loggedErrors.push({ msg, err, ctx });
    });
    const consoleErrorSpy = spyOn(console, "error").mockImplementation((...args) => {
      loggedConsoleMessages.push(args.map(String).join(" "));
    });

    try {
      const explodingDispatcher = new McpDispatcher(hostileContext);
      (explodingDispatcher as any).executeTool = () => {
        throw new Error(
          `Fatal driver leak: password=${syntheticPassword} and bearer ${syntheticToken} while connecting to database cluster`,
        );
      };

      const explodeResponse = (await explodingDispatcher.handle({
        jsonrpc: "2.0",
        id: 1000,
        method: "tools/call",
        params: { name: "list_connections" },
      })) as any;

      // 1. Client does not receive secret
      expect(explodeResponse.id).toBe(1000);
      expect(explodeResponse.error.code).toBe(JSON_RPC_ERRORS.INTERNAL_ERROR);
      expect(explodeResponse.error.message).not.toContain(syntheticPassword);
      expect(explodeResponse.error.message).not.toContain(syntheticToken);
      expect(JSON.stringify(explodeResponse)).not.toContain(syntheticPassword);
      expect(JSON.stringify(explodeResponse)).not.toContain(syntheticToken);

      // 2. Logger does not receive secret
      expect(loggedErrors.length).toBe(1);
      const logged = loggedErrors[0];
      expect(logged.msg).toBe("Error dispatching MCP request");
      expect(logged.ctx).toEqual({ method: "tools/call" });
      expect(logged.err.message).not.toContain(syntheticPassword);
      expect(logged.err.message).not.toContain(syntheticToken);
      if (logged.err.stack) {
        expect(logged.err.stack).not.toContain(syntheticPassword);
        expect(logged.err.stack).not.toContain(syntheticToken);
      }
      for (const consoleMsg of loggedConsoleMessages) {
        expect(consoleMsg).not.toContain(syntheticPassword);
        expect(consoleMsg).not.toContain(syntheticToken);
      }

      // 3. Redacted message maintains diagnostic value
      expect(explodeResponse.error.message).toContain("Fatal driver leak:");
      expect(explodeResponse.error.message).toContain("password=[REDACTED]");
      expect(explodeResponse.error.message).toContain("bearer [REDACTED]");
      expect(explodeResponse.error.message).toContain("while connecting to database cluster");
      expect(logged.err.message).toContain("Fatal driver leak:");
      expect(logged.err.message).toContain("password=[REDACTED]");
      expect(logged.err.message).toContain("bearer [REDACTED]");
    } finally {
      loggerErrorSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });

  test("redacts URIs with credentials and query string tokens in dispatcher and logger", async () => {
    const syntheticUriSecret = "dummy_uri_password";
    const syntheticQueryToken = "dummy_query_token";

    const hostileContext = {
      listPublicConnections: () => {
        throw new Error("Simulated connection listing error");
      },
    } as any;

    const loggedErrors: Array<{ msg: string; err: any; ctx?: any }> = [];
    const loggerErrorSpy = spyOn(logger, "error").mockImplementation((msg, err, ctx) => {
      loggedErrors.push({ msg, err, ctx });
    });

    try {
      const explodingDispatcher = new McpDispatcher(hostileContext);
      (explodingDispatcher as any).executeTool = () => {
        throw new Error(
          `Database connection error: postgres://admin:${syntheticUriSecret}@db.internal:5432/corp?token=${syntheticQueryToken}&env=prod`,
        );
      };

      const response = (await explodingDispatcher.handle({
        jsonrpc: "2.0",
        id: 1001,
        method: "tools/call",
        params: { name: "list_connections" },
      })) as any;

      expect(response.error.code).toBe(JSON_RPC_ERRORS.INTERNAL_ERROR);
      expect(response.error.message).not.toContain(syntheticUriSecret);
      expect(response.error.message).not.toContain(syntheticQueryToken);
      expect(response.error.message).toContain("postgres://[REDACTED]@db.internal:5432/corp?token=[REDACTED]&env=prod");

      expect(loggedErrors.length).toBe(1);
      expect(loggedErrors[0].err.message).not.toContain(syntheticUriSecret);
      expect(loggedErrors[0].err.message).not.toContain(syntheticQueryToken);
      expect(loggedErrors[0].err.message).toContain(
        "postgres://[REDACTED]@db.internal:5432/corp?token=[REDACTED]&env=prod",
      );
    } finally {
      loggerErrorSpy.mockRestore();
    }
  });

  test("preserves all response IDs and returns per-id error when batch response exceeds wire budget", async () => {
    const customContext = {
      listPublicConnections: () => [],
    } as any;
    const customDispatcher = new McpDispatcher(customContext);

    // Mock executeTool to return a large payload (~25 KiB each)
    let callCount = 0;
    (customDispatcher as any).executeTool = async () => {
      callCount++;
      return {
        content: [
          {
            type: "text",
            text: "X".repeat(25 * 1024),
          },
        ],
      };
    };

    const warnings: Array<{ msg: string; ctx?: any }> = [];
    const warnSpy = spyOn(logger, "warn").mockImplementation((msg, ctx) => {
      warnings.push({ msg, ctx });
    });

    try {
      // 5 requests with IDs -> 5 * 25 KiB = 125 KiB, exceeds 64 KiB
      const batch = Array.from({ length: 5 }, (_, i) => ({
        jsonrpc: "2.0",
        id: `batch-req-${i + 1}`,
        method: "tools/call",
        params: { name: "run_read_query" },
      }));

      const responses = (await customDispatcher.handle(batch)) as any[];
      expect(responses).toBeArray();
      expect(responses.length).toBe(5);
      expect(callCount).toBe(5);

      // Verify every request received a response matching its original ID
      for (let i = 0; i < 5; i++) {
        expect(responses[i].id).toBe(`batch-req-${i + 1}`);
      }

      // The earlier responses that fit returned the result
      expect(responses[0].result).toBeDefined();

      // The overflowing trailing responses were replaced with per-id errors
      const overflowResponse = responses[responses.length - 1];
      expect(overflowResponse.error).toBeDefined();
      expect(overflowResponse.error.code).toBe(JSON_RPC_ERRORS.INTERNAL_ERROR);
      expect(overflowResponse.error.message).toBe("Response exceeded the MCP batch output limit");

      // Verify total serialized batch fits within 64 KiB
      const totalWireBytes = Buffer.byteLength(JSON.stringify(responses), "utf-8");
      expect(totalWireBytes).toBeLessThanOrEqual(64 * 1024);

      // Verify warning log was emitted
      expect(warnings.some((w) => w.msg.includes("MCP batch response wire budget exceeded"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
