import { describe, expect, mock, test } from "bun:test";
import { McpConnectionContext } from "@/lib/mcp/context";
import { McpCancellationManager } from "@/lib/mcp/guards/cancellation";
import { executeListConnections } from "@/lib/mcp/tools/list-connections";
import { executeInspectSchema } from "@/lib/mcp/tools/inspect-schema";
import { executeRunReadQuery } from "@/lib/mcp/tools/run-read-query";
import type { DatabaseConnection } from "@/lib/db/types";

describe("MCP Edge Cases & Full Line Coverage", () => {
  const dummyConn: DatabaseConnection = {
    id: "edge-conn",
    name: "Edge DB",
    type: "sqlite",
    database: ":memory:",
    environment: "production",
    createdAt: new Date(),
  };

  test("executeListConnections retorna isError quando os parâmetros são inválidos", async () => {
    const context = new McpConnectionContext([dummyConn]);
    const res = await executeListConnections({ environment: 123 as any }, context);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Failed to list connections");
  });

  test("executeInspectSchema cobre include_columns, include_indexes, falha de describeObject e schema inexistente", async () => {
    let describeThrows = false;
    const mockProvider = {
      listContainers: async () => [{ name: "main", path: ["main"] }],
      listObjects: async () => [
        { name: "users", path: ["main", "users"], kind: "table" },
        { name: "logs", path: ["main", "logs"], kind: "table" },
      ],
      describeObject: async () => {
        if (describeThrows) throw new Error("Falha no describe");
        return {
          columns: [
            { name: "id", type: "INTEGER", nullable: false, defaultValue: 1, isPrimary: true },
            { name: "username", type: "TEXT", nullable: true },
          ],
          indexes: [{ name: "idx_users_id", columns: ["id"], unique: true }],
        };
      },
    };

    const mockContext: any = {
      getProvider: async (_connId: string, profile?: string) => {
        if (profile === "agent-operations") return mockProvider;
        return mockProvider;
      },
    };

    // 1. Inspecionar com colunas e índices
    const resWithCols = await executeInspectSchema(
      { connection_id: "edge-conn", table: "users", include_columns: true, include_indexes: true },
      mockContext,
    );
    expect(resWithCols.isError).toBeUndefined();
    expect(resWithCols.content[0].text).toContain("idx_users_id");
    expect(resWithCols.content[0].text).toContain("username");

    // 2. Describe falhando
    describeThrows = true;
    const resDescribeFail = await executeInspectSchema(
      { connection_id: "edge-conn", include_columns: true },
      mockContext,
    );
    expect(resDescribeFail.content[0].text).toContain("[Partial schema: failed to describe columns]");

    // 3. Schema inexistente
    const resMissingSchema = await executeInspectSchema(
      { connection_id: "edge-conn", schema: "non_existent_schema" },
      mockContext,
    );
    expect(resMissingSchema.isError).toBe(true);
    expect(resMissingSchema.content[0].text).toContain('Schema "non_existent_schema" not found');

    // 4. Erro fatal ao obter provider
    const failingContext: any = {
      getProvider: async () => {
        throw new Error("Conexão indisponível");
      },
    };
    const resFatal = await executeInspectSchema({ connection_id: "broken" }, failingContext);
    expect(resFatal.isError).toBe(true);
    expect(resFatal.content[0].text).toContain("Conexão indisponível");
  });

  test("executeRunReadQuery cobre pre-aborted signal, invalid args, provider cancelQuery, timeout e listener", async () => {
    const manager = new McpCancellationManager();

    // 1. Pre-aborted signal
    const preAborted = AbortSignal.abort("cancelled upfront");
    const resPreAbort = await executeRunReadQuery({ connection_id: "edge-conn", sql: "SELECT 1" }, {} as any, {
      signal: preAborted,
    });
    expect(resPreAbort.isError).toBe(true);
    expect(resPreAbort.content[0].text).toContain("cancelled upfront");

    // 2. Parâmetros inválidos (ZodError)
    const resInvalidArgs = await executeRunReadQuery({ connection_id: 123 as any, sql: "" }, {} as any);
    expect(resInvalidArgs.isError).toBe(true);
    expect(resInvalidArgs.content[0].text).toContain("Invalid parameters");

    // 3. Aborted signal durante conexão com o banco
    const abortCtrl = new AbortController();
    const slowContext: any = {
      getConnection: () => dummyConn,
      getProvider: async () => {
        abortCtrl.abort("aborted during connect");
        return {};
      },
    };
    const resAbortedMid = await executeRunReadQuery({ connection_id: "edge-conn", sql: "SELECT 1" }, slowContext, {
      signal: abortCtrl.signal,
    });
    expect(resAbortedMid.isError).toBe(true);
    expect(resAbortedMid.content[0].text).toContain("aborted during connect");

    // 4. Provider com cancelQuery e abort event listener acionado
    let providerCancelCalled = false;
    const mockProvider = {
      readOnlyProfile: true,
      prepareQuery: (sql: string, opts: any) => ({ query: sql, limit: opts.limit, offset: 0, wasLimited: false }),
      cancelQuery: async () => {
        providerCancelCalled = true;
      },
      queryReadOnly: async () => {
        await new Promise((r) => setTimeout(r, 700));
        return { rows: [{ x: 1 }], fields: ["x"] };
      },
    };

    const activeContext: any = {
      getConnection: () => dummyConn,
      getProvider: async () => mockProvider,
    };

    const liveAbortCtrl = new AbortController();
    const queryPromise = executeRunReadQuery(
      { connection_id: "edge-conn", sql: "SELECT 1", timeout_ms: 2000 },
      activeContext,
      {
        requestId: "req-listener-test",
        signal: liveAbortCtrl.signal,
        cancellationManager: manager,
      },
    );

    await new Promise((r) => setTimeout(r, 10));
    liveAbortCtrl.abort("aborted via event listener");

    const cancelRes = await queryPromise;
    expect(cancelRes.isError).toBe(true);
    expect(providerCancelCalled).toBe(true);

    // 5. Query timeout
    const timeoutPromise = executeRunReadQuery(
      { connection_id: "edge-conn", sql: "SELECT 1", timeout_ms: 500 },
      activeContext,
      { cancellationManager: manager, requestId: "req-timeout" },
    );

    const timeoutRes = await timeoutPromise;
    expect(timeoutRes.isError).toBe(true);
    expect(timeoutRes.content[0].text).toContain("Timeout after 500ms");
  });

  test("executeRunReadQuery cobre redução geométrica de linhas (Passo B)", async () => {
    const massiveRows: any[] = [];
    for (let i = 0; i < 100; i++) {
      const row: any = { id: i };
      for (let c = 0; c < 30; c++) {
        row[`col_${c}_${"x".repeat(30)}`] = "data_".repeat(60);
      }
      massiveRows.push(row);
    }

    const mockProvider = {
      readOnlyProfile: true,
      prepareQuery: (sql: string, opts: any) => ({ query: sql, limit: opts.limit, offset: 0, wasLimited: false }),
      queryReadOnly: async () => ({
        rows: massiveRows,
        fields: Object.keys(massiveRows[0]).map((name) => ({ name })),
      }),
    };

    const mockContext: any = {
      getConnection: () => dummyConn,
      getProvider: async () => mockProvider,
    };

    const res = await executeRunReadQuery({ connection_id: "edge-conn", sql: "SELECT 1" }, mockContext);
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('"truncated": true');
    const bytes = Buffer.byteLength(res.content[0].text, "utf8");
    expect(bytes).toBeLessThanOrEqual(65536);
  });

  test("executeRunReadQuery cobre poda de colunas excedentes (Passo D) quando uma única linha excede o orçamento", async () => {
    // 1 linha com 2000 colunas
    const singleRow: Record<string, unknown> = {};
    const fieldsList: Array<{ name: string }> = [];
    for (let c = 0; c < 2000; c++) {
      const colName = `col_${c}_long_column_identifier`;
      singleRow[colName] = `val_${c}_payload_data`;
      fieldsList.push({ name: colName });
    }

    const mockWideProvider = {
      readOnlyProfile: true,
      prepareQuery: (sql: string, opts: any) => ({ query: sql, limit: opts.limit, offset: 0, wasLimited: false }),
      queryReadOnly: async () => ({
        rows: [singleRow],
        fields: fieldsList,
      }),
    };

    const mockWideContext: any = {
      getConnection: () => dummyConn,
      getProvider: async () => mockWideProvider,
    };

    const res = await executeRunReadQuery({ connection_id: "edge-conn", sql: "SELECT 1" }, mockWideContext);
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain("_truncation_warning");
    expect(res.content[0].text).toContain('"truncated": true');
    const bytes = Buffer.byteLength(res.content[0].text, "utf8");
    expect(bytes).toBeLessThanOrEqual(65536);
  });

  test("McpConnectionContext.disconnectAll captura exceções de providers sem quebrar", async () => {
    const brokenProvider: any = {
      disconnect: async () => {
        throw new Error("Falha ao desconectar provider remoto");
      },
    };
    McpConnectionContext.setCachedProvider("broken-conn", undefined, brokenProvider);

    const ctx = new McpConnectionContext([dummyConn]);
    // Não deve lançar erro
    await expect(ctx.disconnectAll()).resolves.toBeUndefined();
  });
});
