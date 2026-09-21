import { describe, expect, test, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLibreDbMcpServer } from "@/lib/mcp/server";
import type { DatabaseConnection } from "@/lib/types";

describe("MCP Integration Handshake & Protocol Flow", () => {
  const sqliteMemoryConn: DatabaseConnection = {
    id: "test-sqlite-mem",
    name: "Test In-Memory SQLite",
    type: "sqlite",
    database: ":memory:",
    createdAt: new Date(),
  };

  test("conecta cliente e servidor MCP via protocolo oficial 2024-11-05", async () => {
    const { server, context } = createLibreDbMcpServer({
      serverName: "test-mcp-server",
      serverVersion: "1.0.0",
      connections: [sqliteMemoryConn],
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client(
      {
        name: "test-client",
        version: "1.0.0",
      },
      {
        capabilities: {},
      },
    );

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // 1. Listar ferramentas registradas
    const toolsResult = await client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name);

    expect(toolNames).toContain("list_connections");
    expect(toolNames).toContain("inspect_schema");
    expect(toolNames).toContain("run_read_query");

    // 2. Chamar list_connections
    const listResult: any = await client.callTool({
      name: "list_connections",
      arguments: {},
    });

    expect(listResult.isError).toBeFalsy();
    const parsedList = JSON.parse(listResult.content[0].text);
    expect(parsedList.length).toBe(1);
    expect(parsedList[0].id).toBe("test-sqlite-mem");
    expect(parsedList[0].engine).toBe("sqlite");

    // 3. Teste Negativo: Tentar executar DROP TABLE via run_read_query
    const dropResult: any = await client.callTool({
      name: "run_read_query",
      arguments: {
        connection_id: "test-sqlite-mem",
        sql: "DROP TABLE users",
      },
    });

    expect(dropResult.isError).toBe(true);
    expect(dropResult.content[0].text).toContain("MCP execution fence rejected");

    // 4. Teste Positivo: Executar consulta SELECT válida no SQLite
    const selectResult: any = await client.callTool({
      name: "run_read_query",
      arguments: {
        connection_id: "test-sqlite-mem",
        sql: "SELECT 42 AS answer, 'libre' AS engine",
      },
    });

    expect(selectResult.isError).toBeFalsy();
    const parsedSelect = JSON.parse(selectResult.content[0].text);
    expect(parsedSelect.connection_id).toBe("test-sqlite-mem");
    expect(parsedSelect.row_count).toBe(1);
    expect(parsedSelect.rows[0].answer).toBe(42);
    expect(parsedSelect.rows[0].engine).toBe("libre");
    expect(parsedSelect.truncated).toBe(false);

    // 5. Inspecionar esquema via inspect_schema
    const schemaResult: any = await client.callTool({
      name: "inspect_schema",
      arguments: {
        connection_id: "test-sqlite-mem",
      },
    });

    expect(schemaResult.isError).toBeFalsy();
    const parsedSchema = JSON.parse(schemaResult.content[0].text);
    expect(parsedSchema.connection_id).toBe("test-sqlite-mem");
    expect(parsedSchema.tables).toBeDefined();

    // 6. Teste de Orçamento de Linhas: consulta com limite de max_rows
    const truncateResult: any = await client.callTool({
      name: "run_read_query",
      arguments: {
        connection_id: "test-sqlite-mem",
        sql: "SELECT 1 AS x UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9 UNION ALL SELECT 10",
        max_rows: 5,
      },
    });

    expect(truncateResult.isError).toBeFalsy();
    const parsedTruncate = JSON.parse(truncateResult.content[0].text);
    expect(parsedTruncate.row_count).toBe(5);
    expect(parsedTruncate.truncated).toBe(true);

    // 7. Teste de Conexão Inexistente: contrato de erro MCP
    const invalidConnResult: any = await client.callTool({
      name: "run_read_query",
      arguments: {
        connection_id: "invalid-conn-id",
        sql: "SELECT 1",
      },
    });

    expect(invalidConnResult.isError).toBe(true);
    expect(invalidConnResult.content[0].text).toContain("Connection not found");

    // 8. Teste de Orçamento de Bytes: 80 colunas largas (80 KiB brutos) devem ser truncadas para <= 64 KiB
    const wideColumnsSql = `SELECT ${Array.from({ length: 80 }, (_, i) => `'${"A".repeat(1024)}' AS col_${i}`).join(", ")}`;
    const wideResult: any = await client.callTool({
      name: "run_read_query",
      arguments: {
        connection_id: "test-sqlite-mem",
        sql: wideColumnsSql,
      },
    });

    expect(wideResult.isError).toBeFalsy();
    const parsedWide = JSON.parse(wideResult.content[0].text);
    expect(parsedWide.byte_size).toBeLessThanOrEqual(64 * 1024);
    expect(parsedWide.truncated).toBe(true);

    // Fechamento gracioso
    await context.closeAll();
    await client.close();
    await server.close();
  });
});
