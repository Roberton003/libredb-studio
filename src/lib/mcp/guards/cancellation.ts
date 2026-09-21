import { logger } from "@/lib/logger";

interface ActiveQueryHandle {
  requestId: string | number;
  connectionId: string;
  abortController: AbortController;
  cancelDatabaseOperation?: () => Promise<void>;
  startedAt: number;
}

/**
 * Gerenciador de cancelamento para o servidor MCP.
 * Mapeia requests ativas e integra com o evento `notifications/cancelled`.
 */
export class McpCancellationManager {
  private activeQueries = new Map<string | number, ActiveQueryHandle>();

  /**
   * Registra uma nova operação em andamento
   */
  public register(
    requestId: string | number,
    connectionId: string,
    cancelDatabaseOperation?: () => Promise<void>,
  ): AbortSignal {
    const abortController = new AbortController();
    this.activeQueries.set(requestId, {
      requestId,
      connectionId,
      abortController,
      cancelDatabaseOperation,
      startedAt: Date.now(),
    });
    return abortController.signal;
  }

  /**
   * Finaliza o registro de uma operação que concluiu
   */
  public deregister(requestId: string | number): void {
    this.activeQueries.delete(requestId);
  }

  /**
   * Manipula a notificação de cancelamento emitida pelo cliente MCP
   */
  public async handleCancellation(requestId: string | number, reason?: string): Promise<boolean> {
    const handle = this.activeQueries.get(requestId);
    if (!handle) {
      return false;
    }

    logger.info("MCP query cancellation requested by client", {
      requestId,
      connectionId: handle.connectionId,
      reason,
      elapsedMs: Date.now() - handle.startedAt,
    });

    handle.abortController.abort(new Error(reason || "Operation cancelled by MCP client"));

    if (handle.cancelDatabaseOperation) {
      try {
        await handle.cancelDatabaseOperation();
      } catch (error) {
        logger.warn("Failed to cancel native database query on engine", { error, requestId });
      }
    }

    this.activeQueries.delete(requestId);
    return true;
  }

  /**
   * Aborta todas as queries em andamento (útil no shutdown gracioso)
   */
  public async abortAll(reason = "Server shutdown"): Promise<void> {
    const handles = Array.from(this.activeQueries.values());
    for (const handle of handles) {
      handle.abortController.abort(new Error(reason));
      if (handle.cancelDatabaseOperation) {
        try {
          await handle.cancelDatabaseOperation();
        } catch {
          // ignore on shutdown
        }
      }
    }
    this.activeQueries.clear();
  }
}
