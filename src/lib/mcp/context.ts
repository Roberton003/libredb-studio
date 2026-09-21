import type { DatabaseConnection } from "@/lib/types";
import type { DatabaseProvider } from "@/lib/db/types";
import { createDatabaseProvider } from "@/lib/db/factory";
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

    const existing = this.activeProviders.get(connection.id);
    if (existing) {
      existing.disconnect?.().catch(() => {});
      this.activeProviders.delete(connection.id);
    }
    this.pendingProviders.delete(connection.id);
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
        read_only: conn.environment === "production",
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
   * Utiliza padrão Single-Flight para evitar abertura de pools duplicados em requisições concorrentes.
   */
  public async getProvider(connectionId: string): Promise<DatabaseProvider> {
    const cached = this.activeProviders.get(connectionId);
    if (cached) {
      if (!cached.isConnected || cached.isConnected()) {
        return cached;
      }
      // Se estava desconectado, limpa e reconecta
      this.activeProviders.delete(connectionId);
    }

    // Se já existe uma inicialização em andamento para este ID, reutiliza a Promise (Single-Flight)
    const pending = this.pendingProviders.get(connectionId);
    if (pending) {
      return pending;
    }

    const connection = this.connections.get(connectionId);
    if (!connection) {
      throw new Error(`Connection not found: "${connectionId}"`);
    }

    const targetVersion = this.connectionVersions.get(connectionId) || 0;

    const initPromise = (async () => {
      try {
        const provider = await createDatabaseProvider(connection);
        // Conectar explicitamente o pool / driver antes de servir queries
        if (typeof provider.connect === "function") {
          await provider.connect();
        }

        // Se a versão mudou durante a inicialização (ex: registerConnection concorrente), descarta o provider obsoleto
        const currentVersion = this.connectionVersions.get(connectionId) || 0;
        if (currentVersion === targetVersion) {
          this.activeProviders.set(connectionId, provider);
        } else {
          provider.disconnect?.().catch(() => {});
        }

        return provider;
      } catch (error) {
        this.activeProviders.delete(connectionId);
        logger.error("Failed to instantiate or connect database provider for MCP", { connectionId, error });
        throw error;
      } finally {
        this.pendingProviders.delete(connectionId);
      }
    })();

    this.pendingProviders.set(connectionId, initPromise);
    return initPromise;
  }

  /**
   * Encerra todos os providers ativos e drena recursos.
   */
  public async closeAll(): Promise<void> {
    const providers = Array.from(this.activeProviders.entries());
    this.activeProviders.clear();
    this.pendingProviders.clear();

    for (const [id, provider] of providers) {
      try {
        await provider.disconnect?.();
      } catch (err) {
        logger.warn("Error disconnecting provider during MCP shutdown", { id, err });
      }
    }
  }
}
