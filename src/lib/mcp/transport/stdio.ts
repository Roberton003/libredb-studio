import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServerInstance } from "../server";
import { logger } from "@/lib/logger";

import { safeJsonStringify } from "../serializer";

/**
 * Inicia o servidor MCP sobre transporte STDIO com blindagem estrita de canais.
 *
 * Princípios de segurança de transporte:
 * 1. process.stdout é exclusivo para frames JSON-RPC do protocolo MCP.
 * 2. Qualquer saída de log, aviso ou depuração vai estritamente para process.stderr.
 * 3. Sinais de término (SIGINT/SIGTERM) realizam drenagem graciosa de conexões.
 */
export async function startStdioMcpServer(instance: McpServerInstance): Promise<void> {
  const { server, context, cancellationManager } = instance;

  // Redirecionar console.log, console.info, console.debug e console.warn para stderr
  // para garantir que process.stdout seja 100% puro para frames JSON-RPC
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalDebug = console.debug;
  const originalWarn = console.warn;

  const writeToStderr = (...args: unknown[]) => {
    try {
      const line = args
        .map((a) => {
          if (typeof a === "object" && a !== null) {
            try {
              return safeJsonStringify(a);
            } catch {
              return String(a);
            }
          }
          return String(a);
        })
        .join(" ");
      process.stderr.write(`${line}\n`);
    } catch {
      process.stderr.write("[STDERR WRITE ERROR]\n");
    }
  };

  console.log = writeToStderr;
  console.info = writeToStderr;
  console.debug = writeToStderr;
  console.warn = writeToStderr;

  const restoreConsole = () => {
    console.log = originalLog;
    console.info = originalInfo;
    console.debug = originalDebug;
    console.warn = originalWarn;
  };

  const transport = new StdioServerTransport();

  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info(`Received ${signal}, shutting down MCP server gracefully...`);
    try {
      await cancellationManager.abortAll(`Server shutdown via ${signal}`);
      await context.closeAll();
      await server.close();
    } catch (err) {
      logger.error("Error during graceful MCP shutdown", { err });
    } finally {
      restoreConsole();
      process.exit(0);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.stdin.on("end", () => shutdown("STDIN_EOF"));
  process.stdin.on("close", () => shutdown("STDIN_CLOSE"));
  process.stdin.on("error", () => shutdown("STDIN_ERROR"));

  await server.connect(transport);
  logger.info("LibreDB Studio MCP Server listening on STDIO");
}
