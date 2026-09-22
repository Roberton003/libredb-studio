import type { DatabaseConnection } from "@/lib/types";
import type { DatabaseProvider } from "@/lib/db/types";
import { acquireExecutionProfileProvider, createDatabaseProvider, type ExecutionProfile } from "@/lib/db/factory";
import type { PublicConnectionMetadata } from "./types";
import { logger } from "@/lib/logger";

export class McpConnectionContext {
  private connections = new Map<string, DatabaseConnection>();
  private activeProviders = new Map<string, DatabaseProvider>();
  private pendingProviders = new Map<string, Promise<DatabaseProvider>>();

  private connectionVersions = new Map<string, number>();

  constructor(initialConnections: DatabaseConnection[] = []) {
    for (const conn of initialConnections) {
      this.registerConnection(conn);
    }
  }

  /**
   * Registra ou atualiza uma conexão disponível internamente.
   * Incrementa a versão para invalidar promessas de inicialização concorrentes em andamento.
   */
  public registerConnection(connection: DatabaseConnection): void {
    const version = (this.connectionVersions.get(connection.id) || 0) + 1;
    this.connectionVersions.set(connection.id, version);

    for (const [key, provider] of this.activeProviders.entries()) {
      if (key === connection.id || key.startsWith(`${connection.id}:`)) {
        provider.disconnect?.().catch(() => {});
        this.activeProviders.delete(key);
      }
    }
    for (const key of this.pendingProviders.keys()) {
      if (key === connection.id || key.startsWith(`${connection.id}:`)) {
        this.pendingProviders.delete(key);
      }
    }
    this.connections.set(connection.id, connection);
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
   * Suporta ExecutionProfile com single-flight mutex chaveado por connectionId:profile,
   * evitando instanciação duplicada durante rajadas concorrentes.
   */
  public async getProvider(connectionId: string, profile?: ExecutionProfile): Promise<DatabaseProvider> {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      throw new Error(`Connection not found: "${connectionId}"`);
    }

    const cacheKey = profile ? `${connectionId}:${profile}` : connectionId;

    const cached = this.activeProviders.get(cacheKey);
    if (cached) {
      if (!cached.isConnected || cached.isConnected()) {
        return cached;
      }
      // Se estava desconectado, limpa e reconecta
      this.activeProviders.delete(cacheKey);
    }

    // Se já existe uma inicialização em andamento para este cacheKey, reutiliza a Promise (Single-Flight)
    const pending = this.pendingProviders.get(cacheKey);
    if (pending) {
      return pending;
    }

    const targetVersion = this.connectionVersions.get(connectionId) || 0;

    const initPromise = (async () => {
      try {
        let provider: DatabaseProvider;
        if (profile) {
          provider = await acquireExecutionProfileProvider(connection, profile);
        } else {
          provider = await createDatabaseProvider(connection);
          // Conectar explicitamente o pool / driver antes de servir queries
          if (typeof provider.connect === "function") {
            await provider.connect();
          }
        }

        // Verificação defensiva de corrida: se a conexão foi re-registrada enquanto
        // estávamos conectando, descarta este provider imediatamente para evitar zumbis
        const currentVersion = this.connectionVersions.get(connectionId) || 0;
        if (currentVersion !== targetVersion) {
          if (typeof provider.disconnect === "function") {
            provider.disconnect().catch(() => {});
          }
          throw new Error(`Connection "${connectionId}" was invalidated during initialization`);
        }

        this.activeProviders.set(cacheKey, provider);
        return provider;
      } finally {
        this.pendingProviders.delete(cacheKey);
      }
    })();

    this.pendingProviders.set(cacheKey, initPromise);
    return initPromise;
  }

  /**
   * Encerra todos os providers ativos gerenciados localmente.
   */
  public async disconnectAll(): Promise<void> {
    const disconnectPromises: Promise<void>[] = [];
    for (const [id, provider] of this.activeProviders.entries()) {
      if (typeof provider.disconnect === "function") {
        disconnectPromises.push(
          provider.disconnect().catch((err) => {
            logger.warn(`Error disconnecting provider during MCP shutdown`, { id, err });
          }),
        );
      }
    }
    this.activeProviders.clear();
    this.pendingProviders.clear();
    await Promise.all(disconnectPromises);
  }

  /**
   * Alias de conveniência para disconnectAll.
   */
  public async closeAll(): Promise<void> {
    return this.disconnectAll();
  }
}
