import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { McpConnectionContext, McpToolCall } from "../context";
import { assertReadOnlyStatement } from "../guards/execution-fence";
import { safeJsonStringify, safeSerialize, redactErrorMessage } from "../serializer";
import { emitAuditEvent } from "@/lib/audit";
import { randomUUID } from "node:crypto";

export const RunReadQueryInputSchema = z.object({
  connection_id: z.string().min(1, "connection_id is required"),
  sql: z.string().min(1, "SQL cannot be empty"),
  max_rows: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
  timeout_ms: z.number().int().min(500).max(30000).default(10000),
});

export type RunReadQueryInput = z.infer<typeof RunReadQueryInputSchema>;

export interface QueryResultEnvelope {
  connection_id: string;
  rows: Array<Record<string, unknown>>;
  row_count: number;
  truncated: boolean;
  byte_size: number;
  execution_time_ms: number;
  fields?: Array<{ name: string; type?: string }>;
  pagination?: {
    limit: number;
    offset: number;
    hasMore: boolean;
    totalReturned: number;
    wasLimited: boolean;
  };
}

const MAX_PAYLOAD_BYTES = 64 * 1024; // 64 KB defensive ceiling for LLMs

/**
 * Executes a read-only SQL query protected by acquireExecutionProfileProvider
 * and strict row, payload, and pagination limits.
 */
async function runReadQuery(args: RunReadQueryInput, call: McpToolCall): Promise<CallToolResult> {
  const startTime = Date.now();
  const signal = call.signal;
  const correlationId = randomUUID();

  // 0. If request was already aborted by client before starting
  if (signal.aborted) {
    const reason = signal.reason || "Client cancelled request";
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Execution cancelled: ${redactErrorMessage(reason instanceof Error ? reason.message : String(reason))}`,
        },
      ],
    };
  }

  const callerId = call.context.caller.username;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let onAbortReject: (() => void) | undefined;

  try {
    // 1. Fail-closed execution fence (Defense in depth: AST / Regex)
    assertReadOnlyStatement(args.sql);

    // 2. Canonical boundary: acquireExecutionProfileProvider with "agent-read-only" profile
    const connection = await call.context.resolve(args.connection_id);
    if (connection === null) throw new Error(`Connection not found: "${args.connection_id}"`);
    const provider = await call.context.acquire(connection, "agent-read-only");

    // If client aborted during provider acquisition/connection
    if (signal.aborted) {
      const reason = signal.reason || "Client cancelled request";
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Execution cancelled: ${redactErrorMessage(reason instanceof Error ? reason.message : String(reason))}`,
          },
        ],
      };
    }

    const startTime = Date.now();

    // 3. Query preparation with pagination (Contract 0.16.2 / #816)
    if (args.offset > 0) {
      const supportsPagination =
        typeof provider.getCapabilities === "function" &&
        provider.getCapabilities().supportsResultPagination === true &&
        typeof provider.prepareQuery === "function";

      if (!supportsPagination) {
        throw new Error(`Provider for connection "${args.connection_id}" does not support result pagination (offset)`);
      }
    }

    const prepared =
      typeof provider.prepareQuery === "function"
        ? provider.prepareQuery(args.sql, { limit: args.max_rows, offset: args.offset })
        : { query: args.sql, limit: args.max_rows, offset: args.offset, wasLimited: false };

    // 4. Protected execution with timeout
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`Query execution timed out after ${args.timeout_ms}ms`));
      }, args.timeout_ms);
    });

    const abortPromise = new Promise<never>((_, reject) => {
      onAbortReject = () => {
        const reason = signal.reason || "Query cancelled";
        const message = reason instanceof Error ? reason.message : String(reason);
        reject(new Error(`Execution cancelled: ${redactErrorMessage(message)}`));
      };

      if (signal.aborted) return onAbortReject();

      signal.addEventListener("abort", onAbortReject, { once: true });
    });

    // Validate that the provider explicitly supports the database-native readOnlyProfile (#328)
    if ((provider as any).readOnlyProfile !== true || typeof provider.queryReadOnly !== "function") {
      throw new Error(
        `Provider for connection "${args.connection_id}" does not support database-native read-only execution profile`,
      );
    }

    const rawResult: any = await Promise.race([
      provider.queryReadOnly(prepared.query, {
        maxResultRows: prepared.limit,
        statementTimeoutMs: args.timeout_ms,
        maxResultBytes: MAX_PAYLOAD_BYTES,
      }),
      timeoutPromise,
      abortPromise,
    ]);

    const executionTimeMs = Date.now() - startTime;
    const rawRows = (rawResult.rows || []) as Array<Record<string, unknown>>;
    const originalCount = rawRows.length;

    // 5. Pagination and row capping (Contract 0.16.2)
    const hasMore = prepared.wasLimited && originalCount === prepared.limit;
    const cappedRows = rawRows.slice(0, prepared.limit);
    let hasFieldTruncation = false;

    // 6. Byte budget check with Safe Serializer and full wire envelope measurement
    let safeRows = safeSerialize(cappedRows) as Array<Record<string, unknown>>;
    let fields: Array<{ name: string }> | undefined = rawResult.fields?.map((f: unknown) => {
      const rawName = typeof f === "string" ? f : String(f);
      if (rawName.length > 64) {
        hasFieldTruncation = true;
        return { name: `${rawName.slice(0, 64)}... [TRUNCATED]` };
      }
      return { name: rawName };
    });

    let truncated = (prepared.wasLimited && hasMore) || originalCount > prepared.limit || hasFieldTruncation;

    function truncateDeepValue(val: unknown, maxLen: number): unknown {
      if (typeof val === "string") {
        return val.length > maxLen ? `${val.slice(0, maxLen)}... [TRUNCATED]` : val;
      }
      if (val !== null && typeof val === "object") {
        const str = safeJsonStringify(val);
        if (str.length > maxLen) {
          return `${str.slice(0, maxLen)}... [TRUNCATED OBJECT]`;
        }
      }
      return val;
    }

    const buildEnvelopeCandidate = (
      r: Array<Record<string, unknown>>,
      f: Array<{ name: string }> | undefined,
      isTruncated: boolean,
    ) => {
      const env: QueryResultEnvelope = {
        connection_id: args.connection_id.length > 64 ? `${args.connection_id.slice(0, 64)}...` : args.connection_id,
        rows: r,
        row_count: r.length,
        truncated: isTruncated,
        byte_size: 0,
        execution_time_ms: executionTimeMs,
        fields: f,
        pagination: {
          limit: prepared.limit,
          offset: prepared.offset,
          hasMore,
          totalReturned: originalCount,
          wasLimited: prepared.wasLimited,
        },
      };

      // Stabilize iterative byte_size calculation to match UTF-8 wire bytes
      let txt = safeJsonStringify(env, 2);
      for (let i = 0; i < 3; i++) {
        const currentBytes = Buffer.byteLength(txt, "utf-8");
        if (env.byte_size === currentBytes) break;
        env.byte_size = currentBytes;
        txt = safeJsonStringify(env, 2);
      }
      const finalBytes = Buffer.byteLength(txt, "utf-8");
      const outerWireBytes = Buffer.byteLength(JSON.stringify(txt), "utf-8");
      return { env, txt, wireBytes: Math.max(finalBytes, outerWireBytes) };
    };

    let candidate = buildEnvelopeCandidate(safeRows, fields, truncated);

    if (candidate.wireBytes > MAX_PAYLOAD_BYTES) {
      // Step A: If more than 50 metadata fields exist, cap them to protect the wire budget
      if (fields && fields.length > 50) {
        fields = [
          ...fields.slice(0, 50),
          { name: `... [TRUNCATED: ${fields.length - 50} additional columns omitted]` },
        ];
        truncated = true;
        candidate = buildEnvelopeCandidate(safeRows, fields, truncated);
      }

      // Step B: Geometric row reduction (75% per iteration)
      while (safeRows.length > 1 && candidate.wireBytes > MAX_PAYLOAD_BYTES) {
        safeRows = safeRows.slice(0, Math.floor(safeRows.length * 0.75));
        truncated = true;
        candidate = buildEnvelopeCandidate(safeRows, fields, truncated);
      }

      // Step C: Truncate deep strings, keys, and objects (256 -> 128 -> 64 -> 32 -> 16)
      if (candidate.wireBytes > MAX_PAYLOAD_BYTES && safeRows.length > 0) {
        let maxFieldLen = 256;
        while (candidate.wireBytes > MAX_PAYLOAD_BYTES && maxFieldLen >= 16) {
          const maxKeyLen = Math.max(32, maxFieldLen);
          safeRows = safeRows.map((row) => {
            const trimmed: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(row)) {
              const safeKey = k.length > maxKeyLen ? `${k.slice(0, maxKeyLen)}...` : k;
              trimmed[safeKey] = truncateDeepValue(v, maxFieldLen);
            }
            return trimmed;
          });
          truncated = true;
          candidate = buildEnvelopeCandidate(safeRows, fields, truncated);
          maxFieldLen = Math.floor(maxFieldLen / 2);
        }
      }

      // Step D: If still exceeding 64 KiB, prune excess columns in rows and metadata
      if (candidate.wireBytes > MAX_PAYLOAD_BYTES && safeRows.length > 0) {
        safeRows = safeRows.map((row) => {
          const entries = Object.entries(row);
          const cappedEntries = entries.slice(0, Math.min(entries.length, 25));
          const trimmed: Record<string, unknown> = Object.fromEntries(cappedEntries);
          trimmed["_truncation_warning"] = "[TRUNCATED: excess columns omitted to respect 64 KB wire budget]";
          return trimmed;
        });
        if (fields && fields.length > 25) {
          fields = [...fields.slice(0, 25), { name: "... [TRUNCATED: excess columns omitted]" }];
        }
        truncated = true;
        candidate = buildEnvelopeCandidate(safeRows, fields, truncated);
      }
    }

    emitAuditEvent({
      type: "agent_operation",
      action: "run_read_query",
      target: args.connection_id,
      user: callerId,
      result: "success",
      duration: executionTimeMs,
      correlationId,
    });

    return {
      content: [
        {
          type: "text",
          text: candidate.txt,
        },
      ],
    };
  } catch (error: any) {
    if (args.connection_id) {
      emitAuditEvent({
        type: "agent_operation",
        action: "run_read_query",
        target: args.connection_id,
        user: callerId,
        result: "failure",
        reason: "agent_execution_failed",
        duration: Date.now() - startTime,
        correlationId,
      });
    }

    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Execution failed: ${redactErrorMessage(error?.message || String(error))}`,
        },
      ],
    };
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (onAbortReject) {
      signal.removeEventListener("abort", onAbortReject);
    }
  }
}

export function registerRunReadQuery(server: McpServer, context: McpConnectionContext): void {
  server.registerTool(
    "run_read_query",
    {
      description:
        "Execute a strictly read-only SQL query (SELECT / WITH) with strict execution guardrails and timeouts.",
      inputSchema: RunReadQueryInputSchema,
    },
    (args, ctx) => runReadQuery(args, { context, signal: ctx.mcpReq.signal }),
  );
}
