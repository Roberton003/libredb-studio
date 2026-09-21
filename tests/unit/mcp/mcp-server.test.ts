import { describe, expect, test } from "bun:test";
import { createLibreDbMcpServer } from "@/lib/mcp/server";
import { McpConnectionContext } from "@/lib/mcp/context";
import type { DatabaseConnection } from "@/lib/types";

describe("MCP Server & Context Unit Tests", () => {
  const mockConnections: DatabaseConnection[] = [
    {
      id: "conn-sqlite-dev",
      name: "SQLite Local Dev",
      type: "sqlite",
      database: ":memory:",
      environment: "development",
      createdAt: new Date(),
    },
    {
      id: "conn-pg-prod",
      name: "Postgres Production",
      type: "postgres",
      host: "db.internal.corp",
      port: 5432,
      database: "prod_db",
      environment: "production",
      password: "SUPER_SECRET_RAW_PASSWORD",
      createdAt: new Date(),
    },
  ];

  test("inicializa McpServer com conexões e contexto", () => {
    const { server, context, cancellationManager } = createLibreDbMcpServer({
      serverName: "test-mcp",
      connections: mockConnections,
    });

    expect(server).toBeDefined();
    expect(context).toBeDefined();
    expect(cancellationManager).toBeDefined();
  });

  test("listPublicConnections oculta senhas e hosts internos (Zero-Leakage)", () => {
    const context = new McpConnectionContext(mockConnections);
    const publicConns = context.listPublicConnections("all");

    expect(publicConns.length).toBe(2);

    const pgConn = publicConns.find((c) => c.id === "conn-pg-prod");
    expect(pgConn).toBeDefined();
    expect(pgConn?.name).toBe("Postgres Production");
    expect(pgConn?.engine).toBe("postgres");
    expect(pgConn?.read_only).toBe(true); // production marcada como read-only

    // Zero-Leakage: senha e host não existem no metadata público
    expect((pgConn as any).password).toBeUndefined();
    expect((pgConn as any).host).toBeUndefined();
  });

  test("filtra conexões por ambiente estrito", () => {
    const context = new McpConnectionContext(mockConnections);

    const devConns = context.listPublicConnections("development");
    expect(devConns.length).toBe(1);
    expect(devConns[0].id).toBe("conn-sqlite-dev");

    const prodConns = context.listPublicConnections("production");
    expect(prodConns.length).toBe(1);
    expect(prodConns[0].id).toBe("conn-pg-prod");
  });

  test("registra e invalida provider ao atualizar conexão", () => {
    const context = new McpConnectionContext(mockConnections);
    expect(context.getConnection("conn-sqlite-dev")?.name).toBe("SQLite Local Dev");

    context.registerConnection({
      id: "conn-sqlite-dev",
      name: "SQLite Renamed",
      type: "sqlite",
      database: ":memory:",
      createdAt: new Date(),
    });

    expect(context.getConnection("conn-sqlite-dev")?.name).toBe("SQLite Renamed");
  });
});
