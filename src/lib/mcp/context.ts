import type { AuthInfo } from "@modelcontextprotocol/server";
import type { Role } from "@/lib/auth";
import { acquireExecutionProfileProvider, profiledCacheKey, type ExecutionProfile } from "@/lib/db/factory";
import type { DatabaseProvider } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import { getManagedConnections, type ManagedConnection } from "@/lib/seed";
import { redactError } from "./serializer";

/**
 * The MCP tools' view of the connections one caller may use (#246).
 *
 * One instance per request, built by the SDK server factory around the verified identity. The
 * seed file is read lazily by the first tool that needs it, so initialize, server/discover and
 * tools/list never depend on it, and within one request it is read once.
 *
 * Acquisition goes through acquireExecutionProfileProvider and nothing else. Concurrent first
 * acquisitions of one connection and profile are joined here, keyed on the factory's own
 * profiledCacheKey, because a second derivation of that key would reopen the divergence
 * GHSA-3wh2-8x78-jfw4 closed (src/lib/db/provider-cache-key.ts). After the key is awaited, the
 * lookup and the insertion happen in one synchronous step, and a settled acquisition leaves the
 * map, so a failed one is retried by the next caller.
 */

export interface McpCaller {
  readonly username: string;
  readonly role: Role;
}

export interface McpToolCall {
  readonly context: McpConnectionContext;
  readonly signal: AbortSignal;
}

/** The identity the verifier put on the token, and an explicit error when it is not there. */
export function mcpCaller(authInfo: AuthInfo): McpCaller {
  const username = authInfo.extra?.username;
  const role = authInfo.extra?.role;
  if (typeof username !== "string" || username === "" || (role !== "admin" && role !== "user")) {
    throw new Error("The verified MCP identity carries no username and role");
  }
  return { username, role };
}

const pendingAcquisitions = new Map<string, Promise<DatabaseProvider>>();

export class McpConnectionContext {
  private visible: Promise<readonly ManagedConnection[]> | null = null;

  constructor(readonly caller: McpCaller) {}

  visibleConnections(): Promise<readonly ManagedConnection[]> {
    this.visible ??= this.load();
    return this.visible;
  }

  async resolve(connectionId: string): Promise<ManagedConnection | null> {
    return (await this.visibleConnections()).find((connection) => connection.id === connectionId) ?? null;
  }

  async acquire(connection: ManagedConnection, profile: ExecutionProfile): Promise<DatabaseProvider> {
    const key = await profiledCacheKey(connection, profile);
    const pending = pendingAcquisitions.get(key);
    if (pending !== undefined) return pending;
    const acquisition = acquireExecutionProfileProvider(connection, profile).finally(() => {
      pendingAcquisitions.delete(key);
    });
    pendingAcquisitions.set(key, acquisition);
    return acquisition;
  }

  private async load(): Promise<readonly ManagedConnection[]> {
    try {
      return await getManagedConnections([this.caller.role]);
    } catch (error) {
      // The pre-SDK route's behaviour, kept until an unreadable seed file becomes an explicit answer.
      logger.warn("Could not load managed connections for MCP", {
        role: this.caller.role,
        error: redactError(error).message,
      });
      return [];
    }
  }
}
