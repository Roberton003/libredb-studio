#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createLibreDbMcpServer, startStdioMcpServer } from "@/lib/mcp";
import type { DatabaseConnection } from "@/lib/types";

function loadConnectionsFromConfig(): DatabaseConnection[] {
  // 1. Tentar caminho explícito via variável de ambiente
  const envConfigPath = process.env.LIBREDB_CONFIG_PATH || process.env.LIBREDB_CONNECTIONS_FILE;
  if (envConfigPath && existsSync(envConfigPath)) {
    try {
      const raw = readFileSync(envConfigPath, "utf-8");
      return JSON.parse(raw);
    } catch (err) {
      process.stderr.write(`[WARN] Failed to read connections from ${envConfigPath}: ${err}\n`);
    }
  }

  // 2. Tentar locais padrão (~/.config/libredb/connections.json ou .libredb/connections.json)
  const defaultPaths = [
    resolve(process.cwd(), ".libredb/connections.json"),
    resolve(process.env.HOME || "~", ".config/libredb/connections.json"),
  ];

  for (const p of defaultPaths) {
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, "utf-8");
        return JSON.parse(raw);
      } catch (err) {
        process.stderr.write(`[WARN] Failed to parse ${p}: ${err}\n`);
      }
    }
  }

  // 3. Fallback: Conexão SQLite local em memória de demonstração se nenhuma configurada
  return [
    {
      id: "demo-sqlite",
      name: "Demo SQLite (Memory)",
      type: "sqlite",
      database: ":memory:",
      createdAt: new Date(),
    },
  ];
}

async function main() {
  const connections = loadConnectionsFromConfig();
  process.stderr.write(`[INFO] LibreDB MCP Server initializing with ${connections.length} connection(s)...\n`);

  const instance = createLibreDbMcpServer({
    serverName: "libredb-studio-mcp",
    serverVersion: "1.0.0",
    connections,
  });

  await startStdioMcpServer(instance);
}

main().catch((error) => {
  process.stderr.write(`[FATAL] LibreDB MCP Server crashed: ${error}\n`);
  process.exit(1);
});
