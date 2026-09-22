import { describe, expect, test } from "bun:test";
import { McpCancellationManager } from "@/lib/mcp/guards/cancellation";

describe("McpCancellationManager", () => {
  test("registra query e retorna AbortSignal ativo", () => {
    const manager = new McpCancellationManager();
    const signal = manager.register("req-1", "conn-1");

    expect(signal).toBeDefined();
    expect(signal.aborted).toBe(false);
  });

  test("handleCancellation aciona abort e invoca cancelDatabaseOperation", async () => {
    const manager = new McpCancellationManager();
    let dbCancelCalled = false;

    const cancelDb = async () => {
      dbCancelCalled = true;
    };

    const signal = manager.register("req-2", "conn-1", cancelDb);
    const result = await manager.handleCancellation("req-2", "User clicked cancel");

    expect(result).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(dbCancelCalled).toBe(true);
  });

  test("handleCancellation retorna false para requestId inexistente", async () => {
    const manager = new McpCancellationManager();
    const result = await manager.handleCancellation("non-existent");
    expect(result).toBe(false);
  });

  test("deregister remove query e chamadas subsequentes de cancelamento retornam false", async () => {
    const manager = new McpCancellationManager();
    manager.register("req-3", "conn-1");
    manager.deregister("req-3");

    const result = await manager.handleCancellation("req-3");
    expect(result).toBe(false);
  });

  test("abortAll cancela todas as queries ativas no shutdown", async () => {
    const manager = new McpCancellationManager();
    let cancelCount = 0;

    const cancelDb = async () => {
      cancelCount++;
    };

    const s1 = manager.register("req-a", "conn-1", cancelDb);
    const s2 = manager.register("req-b", "conn-2", cancelDb);

    await manager.abortAll("Graceful termination");

    expect(s1.aborted).toBe(true);
    expect(s2.aborted).toBe(true);
    expect(cancelCount).toBe(2);
  });

  test("executeRunReadQuery falha imediatamente (Fail-Fast) ao ser cancelada via McpCancellationManager", async () => {
    const manager = new McpCancellationManager();
    let queryFinishedNormally = false;

    const mockProvider = {
      readOnlyProfile: true,
      prepareQuery: (sql: string, opts: any) => ({ query: sql, limit: opts.limit, offset: 0, wasLimited: false }),
      queryReadOnly: async () => {
        // Simula query lenta em banco de dados assíncrono (500ms)
        await new Promise((resolve) => setTimeout(resolve, 500));
        queryFinishedNormally = true;
        return { rows: [{ val: 1 }], fields: ["val"] };
      },
    };

    const mockContext: any = {
      getConnection: () => ({ id: "mock-conn", type: "postgres" }),
      getProvider: async () => mockProvider,
    };

    const { executeRunReadQuery } = await import("@/lib/mcp/tools/run-read-query");

    const queryPromise = executeRunReadQuery({ connection_id: "mock-conn", sql: "SELECT 1" }, mockContext, {
      requestId: "fast-cancel-req",
      cancellationManager: manager,
    });

    // Espera 10ms para garantir que a query iniciou e está pendente
    await new Promise((r) => setTimeout(r, 10));

    // Cliente envia cancelamento usando o ID público da requisição
    const cancelHandled = await manager.handleCancellation("fast-cancel-req", "Client disconnected");
    expect(cancelHandled).toBe(true);

    const start = Date.now();
    const result = await queryPromise;
    const elapsed = Date.now() - start;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("cancelled");
    expect(queryFinishedNormally).toBe(false);
    expect(elapsed).toBeLessThan(100);
  });
});
