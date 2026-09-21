import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpConnectionContext } from "./context";
import { McpCancellationManager } from "./guards/cancellation";
import { registerInspectSchemaTool } from "./tools/inspect-schema";
import { registerListConnectionsTool } from "./tools/list-connections";
import { registerRunReadQueryTool } from "./tools/run-read-query";
import type { McpServerConfig } from "./types";

export interface McpServerInstance {
  server: McpServer;
  context: McpConnectionContext;
  cancellationManager: McpCancellationManager;
}

/**
 * Cria e configura uma instância do McpServer do LibreDB Studio
 */
export function createLibreDbMcpServer(config: McpServerConfig = {}): McpServerInstance {
  const server = new McpServer({
    name: config.serverName || "libredb-studio-mcp",
    version: config.serverVersion || "1.0.0",
  });

  const context = new McpConnectionContext(config.connections || []);
  const cancellationManager = new McpCancellationManager();

  // Registrar as três ferramentas essenciais da Fase 1
  registerListConnectionsTool(server, context);
  registerInspectSchemaTool(server, context);
  registerRunReadQueryTool(server, context, cancellationManager);

  return {
    server,
    context,
    cancellationManager,
  };
}
