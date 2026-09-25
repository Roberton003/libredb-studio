import type { DatabaseConnection } from "@/lib/types";
import type { DatabaseProvider } from "@/lib/db/types";
import {
  acquireExecutionProfileProvider,
  getOrCreateProvider,
  clearProviderCache,
  type ExecutionProfile,
} from "@/lib/db/factory";
import type { PublicConnectionMetadata } from "./types";
import { logger } from "@/lib/logger";
import { redactError } from "./serializer";

export class McpConnectionContext {
  private connections = new Map<string, DatabaseConnection>();
  private static testMockProviders = new Map<string, DatabaseProvider>();
  private static pendingAcquisitions = new Map<string, Promise<DatabaseProvider>>();

  private static getCacheKey(connectionId: string, profile?: ExecutionProfile): string {
    return JSON.stringify([connectionId, profile ?? null]);
  }

  constructor(initialConnections: DatabaseConnection[] = []) {
    for (const conn of initialConnections) {
      this.registerConnection(conn);
    }
  }

  /**
   * Registers or updates an available connection configuration internally.
   */
  public registerConnection(connection: DatabaseConnection): void {
    this.connections.set(connection.id, connection);
  }

  /**
   * Returns a sanitized list of public connections without credentials (zero-leakage).
   */
  public listPublicConnections(environment = "all"): PublicConnectionMetadata[] {
    const list: PublicConnectionMetadata[] = [];
    for (const conn of this.connections.values()) {
      if (environment !== "all") {
        if (!conn.environment || conn.environment !== environment) {
          continue;
        }
      }
      list.push({
        id: conn.id,
        name: conn.name,
        engine: conn.type,
        database: conn.database,
        read_only: conn.environment === "production" || (conn as any).readOnly === true,
        environment: conn.environment,
      });
    }
    return list;
  }

  /**
   * Returns raw connection configuration (for internal factory use only).
   */
  public getConnection(id: string): DatabaseConnection | undefined {
    return this.connections.get(id);
  }

  /**
   * Acquires a database provider via the canonical factory (acquireExecutionProfileProvider or getOrCreateProvider).
   * Uses a static single-flight promise map to avoid redundant concurrent connection attempts for the same target.
   */
  public async getProvider(connectionId: string, profile?: ExecutionProfile): Promise<DatabaseProvider> {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      throw new Error(`Connection not found: "${connectionId}"`);
    }

    const cacheKey = McpConnectionContext.getCacheKey(connectionId, profile);

    // 1. Check unit test mock seam
    const mock = McpConnectionContext.testMockProviders.get(cacheKey);
    if (mock) {
      if (!mock.isConnected || mock.isConnected()) {
        return mock;
      }
      McpConnectionContext.testMockProviders.delete(cacheKey);
    }

    // 2. Single-flight acquisition mutex
    const inFlight = McpConnectionContext.pendingAcquisitions.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const acquisitionPromise = (async () => {
      try {
        if (profile) {
          return await acquireExecutionProfileProvider(connection, profile);
        }
        return await getOrCreateProvider(connection);
      } finally {
        McpConnectionContext.pendingAcquisitions.delete(cacheKey);
      }
    })();

    McpConnectionContext.pendingAcquisitions.set(cacheKey, acquisitionPromise);
    return acquisitionPromise;
  }

  /**
   * Disconnects all active providers and resets provider caches.
   */
  public static async disconnectActiveProviders(): Promise<void> {
    const disconnectPromises: Promise<void>[] = [];

    for (const [key, provider] of McpConnectionContext.testMockProviders.entries()) {
      if (typeof provider.disconnect === "function") {
        disconnectPromises.push(
          provider.disconnect().catch((err) => {
            logger.warn(`Error disconnecting provider during MCP shutdown`, { key, error: redactError(err) });
          }),
        );
      }
    }
    McpConnectionContext.testMockProviders.clear();
    McpConnectionContext.pendingAcquisitions.clear();

    await Promise.all(disconnectPromises);
    await clearProviderCache();
  }

  public async disconnectAll(): Promise<void> {
    return McpConnectionContext.disconnectActiveProviders();
  }

  /**
   * Test seam for injecting mocked database providers during isolated unit tests.
   */
  public static setCachedProvider(
    connectionId: string,
    profile: ExecutionProfile | undefined,
    provider: DatabaseProvider,
  ): void {
    const key = McpConnectionContext.getCacheKey(connectionId, profile);
    McpConnectionContext.testMockProviders.set(key, provider);
  }

  public static async resetGlobalCache(): Promise<void> {
    await McpConnectionContext.disconnectActiveProviders();
  }

  /**
   * Convenience alias for disconnectAll.
   */
  public async closeAll(): Promise<void> {
    return this.disconnectAll();
  }
}
