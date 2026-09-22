import { describe, expect, test } from "bun:test";
import { McpConnectionContext } from "@/lib/mcp/context";
import { McpDispatcher } from "@/lib/mcp/dispatcher";
import { McpCancellationManager } from "@/lib/mcp/guards/cancellation";
import { JSON_RPC_ERRORS } from "@/lib/mcp/types";
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
    cancellationManager.register("test-req-1", "conn-x", async () => {
      cancelled = true;
    });

    const response = await dispatcher.handle({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: "test-req-1", reason: "User cancelled" },
    });

    expect(response).toBeNull();
    expect(cancelled).toBe(true);
  });
});
