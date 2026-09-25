import type { McpConnectionContext } from "../context";
import { safeJsonStringify, redactErrorMessage } from "../serializer";
import {
  type InspectSchemaInput,
  InspectSchemaInputSchema,
  type McpCallResult,
  type SchemaInspectionResult,
} from "../types";
import { emitAuditEvent } from "@/lib/audit";

export interface InspectSchemaOptions {
  requestId?: string | number | null;
  callerId?: string | null;
}

/**
 * Inspects database schema, tables, views, and columns across supported engines
 * using the canonical 'agent-operations' profile.
 */
export async function executeInspectSchema(
  args: unknown,
  context: McpConnectionContext,
  opts?: InspectSchemaOptions,
): Promise<McpCallResult> {
  const startedAt = Date.now();
  let parsedConnectionId: string | undefined;
  const callerId = opts?.callerId || "anonymous";
  const correlationId = opts?.requestId !== undefined && opts?.requestId !== null ? String(opts.requestId) : undefined;

  try {
    const parsed: InspectSchemaInput = InspectSchemaInputSchema.parse(args || {});
    parsedConnectionId = parsed.connection_id;
    const provider = await context.getProvider(parsed.connection_id, "agent-operations");

    // 1. Determine target container (schema/catalog)
    const containers = await provider.listContainers();

    let targetContainer: any;
    if (parsed.schema) {
      targetContainer = containers.find((c: any) => c.name.toLowerCase() === parsed.schema?.toLowerCase());
      if (!targetContainer) {
        emitAuditEvent({
          type: "agent_operation",
          action: "inspect_schema",
          target: parsed.connection_id,
          user: callerId,
          result: "failure",
          reason: "agent_execution_failed",
          duration: Date.now() - startedAt,
          correlationId,
        });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Schema "${parsed.schema}" not found in connection "${parsed.connection_id}".`,
            },
          ],
        };
      }
    } else {
      targetContainer = containers[0];
    }

    const containerPath = targetContainer ? targetContainer.path : [];

    // 2. List objects of type "table"
    const allObjects = await provider.listObjects(containerPath, "table");

    // Filter by specific table if provided
    const filteredObjects = parsed.table
      ? allObjects.filter((o: any) => o.name.toLowerCase() === parsed.table?.toLowerCase())
      : allObjects;

    const totalTables = filteredObjects.length;
    const paginatedObjects = filteredObjects.slice(parsed.offset, parsed.offset + parsed.limit);
    const hasMore = parsed.offset + parsed.limit < totalTables;

    const tablesDetails: SchemaInspectionResult["tables"] = [];

    for (const obj of paginatedObjects) {
      let columns: SchemaInspectionResult["tables"][0]["columns"] | undefined;
      let indexes: SchemaInspectionResult["tables"][0]["indexes"] | undefined;
      let comment: string | undefined = (obj as any).comment;

      if (parsed.include_columns || parsed.include_indexes) {
        const detail = await provider.describeObject(obj.path, "table");
        if ((detail as any)?.comment) {
          comment = (detail as any).comment;
        }

        if (parsed.include_columns && detail.columns) {
          const rawCols = Array.isArray(detail.columns) ? detail.columns : [];
          const isColsTruncated = rawCols.length > 50;
          const slicedCols = rawCols.slice(0, 50);
          columns = slicedCols.map((c: any) => ({
            name: c.name,
            data_type: c.type,
            is_nullable: c.nullable ?? true,
            default_value: c.defaultValue !== undefined ? String(c.defaultValue) : null,
            is_primary_key: Boolean(c.isPrimary),
          }));
          if (isColsTruncated) {
            columns.push({
              name: `... [TRUNCATED: ${rawCols.length - 50} additional columns omitted]`,
              data_type: "text",
              is_nullable: true,
              default_value: null,
              is_primary_key: false,
            });
          }
        }

        if (parsed.include_indexes && detail.indexes) {
          const rawIdx = Array.isArray(detail.indexes) ? detail.indexes : [];
          const isIdxTruncated = rawIdx.length > 25;
          const slicedIdx = rawIdx.slice(0, 25);
          indexes = slicedIdx.map((idx: any) => ({
            name: idx.name,
            columns: [...idx.columns],
            is_unique: Boolean(idx.unique),
          }));
          if (isIdxTruncated) {
            indexes.push({
              name: `... [TRUNCATED: ${rawIdx.length - 25} additional indexes omitted]`,
              columns: [],
              is_unique: false,
            });
          }
        }
      }

      tablesDetails.push({
        name: obj.name,
        kind: (obj.kind as "table" | "view" | "materialized_view") || "table",
        comment,
        columns,
        indexes,
      });
    }

    const result: SchemaInspectionResult = {
      connection_id: parsed.connection_id,
      schema: targetContainer ? targetContainer.name : "default",
      total_tables: totalTables,
      limit: parsed.limit,
      offset: parsed.offset,
      has_more: hasMore,
      tables: tablesDetails,
    };

    let jsonText = safeJsonStringify(result, 2);
    // Defense in depth: if payload still exceeds 64 KiB, truncate tables
    if (Buffer.byteLength(jsonText) > 64 * 1024) {
      while (tablesDetails.length > 1 && Buffer.byteLength(safeJsonStringify(result, 2)) > 64 * 1024) {
        tablesDetails.pop();
      }
      result.has_more = true;
      jsonText = safeJsonStringify(result, 2);
    }

    emitAuditEvent({
      type: "agent_operation",
      action: "inspect_schema",
      target: parsed.connection_id,
      user: callerId,
      result: "success",
      duration: Date.now() - startedAt,
      correlationId,
    });

    return {
      content: [
        {
          type: "text",
          text: jsonText,
        },
      ],
    };
  } catch (error: any) {
    if (parsedConnectionId) {
      emitAuditEvent({
        type: "agent_operation",
        action: "inspect_schema",
        target: parsedConnectionId,
        user: callerId,
        result: "failure",
        reason: "agent_execution_failed",
        duration: Date.now() - startedAt,
        correlationId,
      });
    }

    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Failed to inspect schema: ${redactErrorMessage(error?.message || String(error))}`,
        },
      ],
    };
  }
}
