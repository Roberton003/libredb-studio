import type { DatabaseConnection } from "@/lib/types";
import type { DatabaseProvider } from "@/lib/db/types";
import { acquireExecutionProfileProvider, getOrCreateProvider, type ExecutionProfile } from "@/lib/db/factory";
import type { PublicConnectionMetadata } from "./types";
import { logger } from "@/lib/logger";
import { redactError } from "./serializer";

export class McpConnectionContext {
  private connections = new Map<string, DatabaseConnection>();
  private static activeProviders = new Map<string, DatabaseProvider>();
  private static pendingProviders = new Map<string, Promise<DatabaseProvider>>();
  private static connectionVersions = new Map<string, number>();
  private static registeredConnectionsJson = new Map<string, string>();

  private static getCacheKey(connectionId: string, profile?: ExecutionProfile): string {
    return JSON.stringify([connectionId, profile ?? null]);
  }

  constructor(initialConnections: DatabaseConnection[] = []) {
    for (const conn of initialConnections) {
      this.registerConnection(conn);
    }
  }

  /**
   * Registra ou atualiza uma conexão disponível internamente.
   * Se a configuração da conexão for idêntica à já registrada, preserva os providers ativos.
   * Se a configuração foi alterada, invalida os providers cacheados e incrementa a versão.
   */
  public registerConnection(connection: DatabaseConnection): void {
    this.connections.set(connection.id, connection);

    const serialized = JSON.stringify(connection);
    const prevSerialized = McpConnectionContext.registeredConnectionsJson.get(connection.id);
    if (prevSerialized === serialized) {
      return;
    }

    McpConnectionContext.registeredConnectionsJson.set(connection.id, serialized);

    // Invalida providers somente se a conexão já existia anteriormente com outra configuração
    if (prevSerialized !== undefined) {
      const version = (McpConnectionContext.connectionVersions.get(connection.id) || 0) + 1;
      McpConnectionContext.connectionVersions.set(connection.id, version);

      for (const [key, provider] of McpConnectionContext.activeProviders.entries()) {
        try {
          const [connId] = JSON.parse(key);
          if (connId === connection.id) {
            provider.disconnect?.().catch(() => {});
            McpConnectionContext.activeProviders.delete(key);
          }
        } catch {
          if (key.includes(connection.id)) {
            provider.disconnect?.().catch(() => {});
            McpConnectionContext.activeProviders.delete(key);
          }
        }
      }
      for (const key of McpConnectionContext.pendingProviders.keys()) {
        try {
          const [connId] = JSON.parse(key);
          if (connId === connection.id) {
            McpConnectionContext.pendingProviders.delete(key);
          }
        } catch {
          if (key.includes(connection.id)) {
            McpConnectionContext.pendingProviders.delete(key);
          }
        }
      }
    }
  }

  /**
   * Retorna a lista de conexões no formato público e sanitizado (Zero-Leakage).
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
   * Obtém a configuração de conexão bruta (apenas para uso interno do provider).
   */
  public getConnection(id: string): DatabaseConnection | undefined {
    return this.connections.get(id);
  }

  /**
   * Obtém ou inicializa com conexão real uma instância de provider.
   * Suporta ExecutionProfile com single-flight mutex estático chaveado sem colisão,
   * garantindo unicidade mesmo entre múltiplos McpConnectionContext instanciados por requisições HTTP distintas.
   */
  public async getProvider(connectionId: string, profile?: ExecutionProfile): Promise<DatabaseProvider> {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      throw new Error(`Connection not found: "${connectionId}"`);
    }

    const cacheKey = McpConnectionContext.getCacheKey(connectionId, profile);

    const cached = McpConnectionContext.activeProviders.get(cacheKey);
    if (cached) {
      if (!cached.isConnected || cached.isConnected()) {
        return cached;
      }
      // Se estava desconectado, limpa e reconecta
      McpConnectionContext.activeProviders.delete(cacheKey);
    }

    // Se já existe uma inicialização em andamento para este cacheKey, reutiliza a Promise (Single-Flight)
    const pending = McpConnectionContext.pendingProviders.get(cacheKey);
    if (pending) {
      return pending;
    }

    const targetVersion = McpConnectionContext.connectionVersions.get(connectionId) || 0;

    const initPromise = (async () => {
      try {
        let provider: DatabaseProvider;
        if (profile) {
          provider = await acquireExecutionProfileProvider(connection, profile);
        } else {
          provider = await getOrCreateProvider(connection);
        }

        // Verificação defensiva de corrida: se a conexão foi re-registrada enquanto
        // estávamos conectando, descarta este provider imediatamente para evitar zumbis
        const currentVersion = McpConnectionContext.connectionVersions.get(connectionId) || 0;
        if (currentVersion !== targetVersion) {
          if (typeof provider.disconnect === "function") {
            provider.disconnect().catch(() => {});
          }
          throw new Error(`Connection "${connectionId}" was invalidated during initialization`);
        }

        McpConnectionContext.activeProviders.set(cacheKey, provider);
        return provider;
      } finally {
        McpConnectionContext.pendingProviders.delete(cacheKey);
      }
    })();

    McpConnectionContext.pendingProviders.set(cacheKey, initPromise);
    return initPromise;
  }

  /**
   * Encerra todos os providers ativos gerenciados globalmente.
   */
  public static async disconnectActiveProviders(): Promise<void> {
    const disconnectPromises: Promise<void>[] = [];
    for (const [key, provider] of McpConnectionContext.activeProviders.entries()) {
      if (typeof provider.disconnect === "function") {
        disconnectPromises.push(
          provider.disconnect().catch((err) => {
            logger.warn(`Error disconnecting provider during MCP shutdown`, { key, error: redactError(err) });
          }),
        );
      }
    }
    McpConnectionContext.activeProviders.clear();
    McpConnectionContext.pendingProviders.clear();
    await Promise.all(disconnectPromises);
  }

  public async disconnectAll(): Promise<void> {
    return McpConnectionContext.disconnectActiveProviders();
  }

  public static setCachedProvider(
    connectionId: string,
    profile: ExecutionProfile | undefined,
    provider: DatabaseProvider,
  ): void {
    const key = McpConnectionContext.getCacheKey(connectionId, profile);
    McpConnectionContext.activeProviders.set(key, provider);
  }

  public static async resetGlobalCache(): Promise<void> {
    await McpConnectionContext.disconnectActiveProviders();
    McpConnectionContext.connectionVersions.clear();
    McpConnectionContext.registeredConnectionsJson.clear();
  }

  /**
   * Alias de conveniência para disconnectAll.
   */
  public async closeAll(): Promise<void> {
    return this.disconnectAll();
  }
}
