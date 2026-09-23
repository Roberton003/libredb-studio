import { logger } from "@/lib/logger";
import { redactErrorMessage } from "../serializer";

interface ActiveQueryHandle {
  callerId: string;
  requestId: string | number;
  connectionId: string;
  abortController: AbortController;
  cancelDatabaseOperation?: () => Promise<void>;
  startedAt: number;
  associatedKeys: Set<string>;
}

/**
 * Cancellation manager for the MCP server.
 * Tracks active requests scoped by caller identity and integrates with the `notifications/cancelled` protocol event.
 */
export class McpCancellationManager {
  private activeQueries = new Map<string, ActiveQueryHandle>();

  private toKey(callerId: string, requestId: string | number): string {
    return JSON.stringify([callerId, typeof requestId, requestId]);
  }

  /**
   * Registers a new running database operation scoped by caller identity.
   */
  public register(
    callerId: string,
    requestId: string | number,
    connectionId: string,
    cancelDatabaseOperation?: () => Promise<void>,
  ): AbortSignal {
    const abortController = new AbortController();
    const key = this.toKey(callerId, requestId);
    const associatedKeys = new Set<string>([key]);
    this.activeQueries.set(key, {
      callerId,
      requestId,
      connectionId,
      abortController,
      cancelDatabaseOperation,
      startedAt: Date.now(),
      associatedKeys,
    });
    return abortController.signal;
  }

  /**
   * Registers an alias for an existing running query under the same caller identity.
   */
  public registerAlias(callerId: string, aliasId: string | number, primaryId: string | number): void {
    const primary = this.activeQueries.get(this.toKey(callerId, primaryId));
    if (primary) {
      const aliasKey = this.toKey(callerId, aliasId);
      primary.associatedKeys.add(aliasKey);
      this.activeQueries.set(aliasKey, primary);
    }
  }

  /**
   * Deregisters a completed operation and purges all of its associated alias keys.
   */
  public deregister(callerId: string, requestId: string | number): void {
    const key = this.toKey(callerId, requestId);
    const handle = this.activeQueries.get(key);
    if (handle) {
      for (const k of handle.associatedKeys) {
        this.activeQueries.delete(k);
      }
    } else {
      this.activeQueries.delete(key);
    }
  }

  /**
   * Handles a cancellation notification emitted by an authenticated MCP client.
   * Atomically purges primary and alias keys before running native database cancel.
   */
  public async handleCancellation(callerId: string, requestId: string | number, reason?: string): Promise<boolean> {
    const key = this.toKey(callerId, requestId);
    const handle = this.activeQueries.get(key);
    if (!handle) {
      return false;
    }

    // Immediately remove all associated keys (primary and all aliases) to prevent orphan handles or double aborts
    for (const k of handle.associatedKeys) {
      this.activeQueries.delete(k);
    }

    logger.info("MCP query cancellation requested by client", {
      callerId,
      requestId,
      connectionId: handle.connectionId,
      reason: reason ? redactErrorMessage(reason) : undefined,
      elapsedMs: Date.now() - handle.startedAt,
    });

    handle.abortController.abort(new Error(reason || "Operation cancelled by MCP client"));

    if (handle.cancelDatabaseOperation) {
      try {
        await handle.cancelDatabaseOperation();
      } catch (error) {
        logger.warn("Failed to cancel native database query on engine", {
          error: redactErrorMessage(error instanceof Error ? error.message : String(error)),
          callerId,
          requestId,
        });
      }
    }

    return true;
  }

  /**
   * Aborts all in-flight queries (used during graceful shutdown).
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
