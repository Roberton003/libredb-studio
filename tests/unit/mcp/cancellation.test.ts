import { describe, expect, test } from "bun:test";
import { McpCancellationManager } from "@/lib/mcp/guards/cancellation";

describe("McpCancellationManager", () => {
  test("registra query e retorna AbortSignal ativo", () => {
    const manager = new McpCancellationManager();
    const signal = manager.register("user-1", "req-1", "conn-1");

    expect(signal).toBeDefined();
    expect(signal.aborted).toBe(false);
  });

  test("handleCancellation aciona abort e invoca cancelDatabaseOperation", async () => {
    const manager = new McpCancellationManager();
    let dbCancelCalled = false;

    const cancelDb = async () => {
      dbCancelCalled = true;
    };

    const signal = manager.register("user-1", "req-2", "conn-1", cancelDb);
    const result = await manager.handleCancellation("user-1", "req-2", "User clicked cancel");

    expect(result).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(dbCancelCalled).toBe(true);
  });

  test("handleCancellation retorna false para requestId inexistente", async () => {
    const manager = new McpCancellationManager();
    const result = await manager.handleCancellation("user-1", "non-existent");
    expect(result).toBe(false);
  });

  test("deregister remove query e chamadas subsequentes de cancelamento retornam false", async () => {
    const manager = new McpCancellationManager();
    manager.register("user-1", "req-3", "conn-1");
    manager.deregister("user-1", "req-3");

    const result = await manager.handleCancellation("user-1", "req-3");
    expect(result).toBe(false);
  });

  test("isola cancelamento entre diferentes usuários (callerId isolation)", async () => {
    const manager = new McpCancellationManager();
    let cancelACalled = false;
    let cancelBCalled = false;

    const s1 = manager.register("user-alpha", "req-shared-id", "conn-1", async () => {
      cancelACalled = true;
    });
    const s2 = manager.register("user-beta", "req-shared-id", "conn-2", async () => {
      cancelBCalled = true;
    });

    const handled = await manager.handleCancellation("user-alpha", "req-shared-id", "Alpha aborted");
    expect(handled).toBe(true);
    expect(s1.aborted).toBe(true);
    expect(cancelACalled).toBe(true);

    // Beta permanece ativo e intocado
    expect(s2.aborted).toBe(false);
    expect(cancelBCalled).toBe(false);

    // Cancelamento do Beta funciona independentemente
    const handledB = await manager.handleCancellation("user-beta", "req-shared-id", "Beta aborted");
    expect(handledB).toBe(true);
    expect(s2.aborted).toBe(true);
    expect(cancelBCalled).toBe(true);
  });

  test("previne colisão de chaves quando callerId ou requestId contêm delimitadores (ex: dois-pontos)", async () => {
    const manager = new McpCancellationManager();
    let cancelACalled = false;
    let cancelBCalled = false;

    // Cenário adversarial de colisão de strings:
    // User A: callerId="a", requestId="b:c"
    // User B: callerId="a:b", requestId="c"
    const s1 = manager.register("a", "b:c", "conn-1", async () => {
      cancelACalled = true;
    });
    const s2 = manager.register("a:b", "c", "conn-2", async () => {
      cancelBCalled = true;
    });

    const handled = await manager.handleCancellation("a", "b:c", "Cancel A");
    expect(handled).toBe(true);
    expect(s1.aborted).toBe(true);
    expect(cancelACalled).toBe(true);

    // B não deve ser cancelado pela colisão de prefixo com delimitador ':'
    expect(s2.aborted).toBe(false);
    expect(cancelBCalled).toBe(false);

    // Cancelar B funciona com sua própria chave exata
    const handledB = await manager.handleCancellation("a:b", "c", "Cancel B");
    expect(handledB).toBe(true);
    expect(s2.aborted).toBe(true);
    expect(cancelBCalled).toBe(true);
  });

  test("abortAll cancela todas as queries ativas no shutdown", async () => {
    const manager = new McpCancellationManager();
    let cancelCount = 0;

    const cancelDb = async () => {
      cancelCount++;
    };

    const s1 = manager.register("user-a", "req-a", "conn-1", cancelDb);
    const s2 = manager.register("user-b", "req-b", "conn-2", cancelDb);

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
      callerId: "user-test",
      cancellationManager: manager,
    });

    // Espera 10ms para garantir que a query iniciou e está pendente
    await new Promise((r) => setTimeout(r, 10));

    // Cliente envia cancelamento usando o ID público da requisição e o mesmo callerId
    const cancelHandled = await manager.handleCancellation("user-test", "fast-cancel-req", "Client disconnected");
    expect(cancelHandled).toBe(true);

    const start = Date.now();
    const result = await queryPromise;
    const elapsed = Date.now() - start;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("cancelled");
    expect(queryFinishedNormally).toBe(false);
    expect(elapsed).toBeLessThan(100);
  });

  test("deregister remove a chave primária e todos os aliases vinculados (zero orphan aliases)", async () => {
    const manager = new McpCancellationManager();
    let cancelCalled = false;
    const signal = manager.register("user-1", "primary-id", "conn-1", async () => {
      cancelCalled = true;
    });
    manager.registerAlias("user-1", "alias-id-1", "primary-id");
    manager.registerAlias("user-1", "alias-id-2", "primary-id");

    // Desregistra via chave primária
    manager.deregister("user-1", "primary-id");

    // Tentativas de cancelamento subsequentes (seja pelo alias 1, alias 2 ou primário) devem retornar false
    expect(await manager.handleCancellation("user-1", "alias-id-1")).toBe(false);
    expect(await manager.handleCancellation("user-1", "alias-id-2")).toBe(false);
    expect(await manager.handleCancellation("user-1", "primary-id")).toBe(false);
    expect(cancelCalled).toBe(false);
    expect(signal.aborted).toBe(false);
  });

  test("handleCancellation via alias purga chave primária e outros aliases atomicamente", async () => {
    const manager = new McpCancellationManager();
    let cancelCount = 0;
    const signal = manager.register("user-1", "req-x", "conn-1", async () => {
      cancelCount++;
    });
    manager.registerAlias("user-1", "req-x-alias", "req-x");

    // Cancela através do alias
    const handled = await manager.handleCancellation("user-1", "req-x-alias", "Client abort via alias");
    expect(handled).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(cancelCount).toBe(1);

    // Nova chamada via chave primária não deve reencontrar o handle nem reexecutar cancelDatabaseOperation
    expect(await manager.handleCancellation("user-1", "req-x")).toBe(false);
    expect(await manager.handleCancellation("user-1", "req-x-alias")).toBe(false);
    expect(cancelCount).toBe(1);
  });
});
