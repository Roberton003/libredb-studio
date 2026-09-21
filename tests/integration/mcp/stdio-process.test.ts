import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

describe("MCP Real STDIO Child Process Integration", () => {
  test("inicia processo bin/libredb-mcp.ts via pipes de SO e executa protocolo real", async () => {
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["bin/libredb-mcp.ts"],
      cwd: process.cwd(),
    });

    const client = new Client(
      {
        name: "stdio-integration-tester",
        version: "1.0.0",
      },
      {
        capabilities: {},
      },
    );

    await client.connect(transport);

    // 1. Listar ferramentas via processo real
    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    expect(toolNames).toContain("list_connections");
    expect(toolNames).toContain("inspect_schema");
    expect(toolNames).toContain("run_read_query");

    // 2. Chamar list_connections
    const listRes: any = await client.callTool({
      name: "list_connections",
      arguments: {},
    });
    expect(listRes.isError).toBeFalsy();
    const connections = JSON.parse(listRes.content[0].text);
    expect(connections.length).toBeGreaterThanOrEqual(1);
    expect(connections[0].engine).toBe("sqlite");

    // 3. Executar query de leitura real via STDIO
    const queryRes: any = await client.callTool({
      name: "run_read_query",
      arguments: {
        connection_id: connections[0].id,
        sql: "SELECT 2026 AS year, 'MCP' AS protocol",
      },
    });
    expect(queryRes.isError).toBeFalsy();
    const parsedQuery = JSON.parse(queryRes.content[0].text);
    expect(parsedQuery.row_count).toBe(1);
    expect(parsedQuery.rows[0].year).toBe(2026);
    expect(parsedQuery.rows[0].protocol).toBe("MCP");

    // 4. Teste negativo via STDIO: comando proibido
    const dropRes: any = await client.callTool({
      name: "run_read_query",
      arguments: {
        connection_id: connections[0].id,
        sql: "DROP TABLE test_forbidden",
      },
    });
    expect(dropRes.isError).toBe(true);
    expect(dropRes.content[0].text).toContain("MCP execution fence rejected");

    // Fechamento limpo do cliente e processo filho
    await client.close();
  });
});
