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

  test("processa requisição 'initialize' e retorna handshake 2024-11-05", async () => {
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

  test("retorna null para notificação 'notifications/initialized'", async () => {
    const notification = {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    };

    const response = await dispatcher.handle(notification);
    expect(response).toBeNull();
  });

  test("processa requisição 'ping' e responde vazio", async () => {
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

  test("lista ferramentas com 'tools/list'", async () => {
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

  test("executa 'tools/call' para 'list_connections' com sucesso", async () => {
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

  test("retorna isError: true para ferramenta inexistente", async () => {
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

  test("rejeita método inexistente com erro METHOD_NOT_FOUND (-32601)", async () => {
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

  test("rejeita requisição malformada com erro INVALID_REQUEST (-32600)", async () => {
    const request = {
      invalid_jsonrpc: "1.0",
      id: 123,
    };

    const response = (await dispatcher.handle(request)) as any;
    expect(response.error.code).toBe(JSON_RPC_ERRORS.INVALID_REQUEST);
  });

  test("processa requisições em lote (Batch)", async () => {
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

  test("rejeita IDs inválidos (null, float, objeto) com INVALID_REQUEST (-32600)", async () => {
    const rNull = (await dispatcher.handle({ jsonrpc: "2.0", id: null, method: "ping" })) as any;
    expect(rNull.error.code).toBe(JSON_RPC_ERRORS.INVALID_REQUEST);

    const rFloat = (await dispatcher.handle({ jsonrpc: "2.0", id: 1.5, method: "ping" })) as any;
    expect(rFloat.error.code).toBe(JSON_RPC_ERRORS.INVALID_REQUEST);

    const rObj = (await dispatcher.handle({ jsonrpc: "2.0", id: { bad: true }, method: "ping" })) as any;
    expect(rObj.error.code).toBe(JSON_RPC_ERRORS.INVALID_REQUEST);
  });

  test("rejeita lote que excede limite de 50 requisições com INVALID_REQUEST", async () => {
    const hugeBatch = Array.from({ length: 51 }, (_, i) => ({
      jsonrpc: "2.0",
      id: i + 1,
      method: "ping",
    }));

    const response = (await dispatcher.handle(hugeBatch)) as any;
    expect(response.error.code).toBe(JSON_RPC_ERRORS.INVALID_REQUEST);
    expect(response.error.message).toContain("limit of 50");
  });

  test("processa notificação notifications/cancelled chamando cancellationManager", async () => {
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

  test("redige credenciais e URIs em mensagens de erro internas capturadas no dispatcher e no logger", async () => {
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

      // 1. O cliente não recebe o secret
      expect(explodeResponse.id).toBe(1000);
      expect(explodeResponse.error.code).toBe(JSON_RPC_ERRORS.INTERNAL_ERROR);
      expect(explodeResponse.error.message).not.toContain(syntheticPassword);
      expect(explodeResponse.error.message).not.toContain(syntheticToken);
      expect(JSON.stringify(explodeResponse)).not.toContain(syntheticPassword);
      expect(JSON.stringify(explodeResponse)).not.toContain(syntheticToken);

      // 2. O logger não recebe o secret
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

      // 3. A mensagem redigida mantém informação diagnóstica útil
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

  test("redige URIs com credenciais e tokens em query string no dispatcher e logger", async () => {
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
});
