import type { McpConnectionContext } from "../context";
import { safeJsonStringify } from "../serializer";
import {
  type InspectSchemaInput,
  InspectSchemaInputSchema,
  type McpCallResult,
  type SchemaInspectionResult,
} from "../types";

/**
 * Executa a inspeção de esquema através de todos os 17 engines do LibreDB Studio
 * utilizando o perfil canônico 'agent-operations' (sem restrição de escrita em bancos single-writer).
 */
export async function executeInspectSchema(args: unknown, context: McpConnectionContext): Promise<McpCallResult> {
  try {
    const parsed = InspectSchemaInputSchema.parse(args || {});
    // Adquire o provider com perfil "agent-operations", suportado em todos os 17 bancos
    let provider: any;
    try {
      provider = await context.getProvider(parsed.connection_id, "agent-operations");
    } catch (err: any) {
      if (
        err?.reasonCode === "PROFILE_UNSUPPORTED_TARGET" ||
        err?.message?.toLowerCase().includes("in-memory") ||
        err?.message?.includes(":memory:")
      ) {
        provider = await context.getProvider(parsed.connection_id);
      } else {
        throw err;
      }
    }

    // 1. Determinar o container (schema/catalog)
    const containers = await provider.listContainers();

    let targetContainer: any;
    if (parsed.schema) {
      targetContainer = containers.find((c: any) => c.name.toLowerCase() === parsed.schema?.toLowerCase());
      if (!targetContainer) {
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

    // 2. Listar objetos da classe "table"
    const allObjects = await provider.listObjects(containerPath, "table");

    // Filtrar por tabela específica se informada
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
      let comment: string | undefined;

      if (parsed.include_columns || parsed.include_indexes) {
        try {
          const detail = await provider.describeObject(obj.path, "table");

          if (parsed.include_columns && detail.columns) {
            columns = detail.columns.map((c: any) => ({
              name: c.name,
              data_type: c.type,
              is_nullable: c.nullable ?? true,
              default_value: c.defaultValue !== undefined ? String(c.defaultValue) : null,
              is_primary_key: Boolean(c.isPrimary),
            }));
          }

          if (parsed.include_indexes && detail.indexes) {
            indexes = detail.indexes.map((idx: any) => ({
              name: idx.name,
              columns: [...idx.columns],
              is_unique: Boolean(idx.unique),
            }));
          }
        } catch {
          comment = "[Partial schema: failed to describe columns]";
          columns = [];
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

    return {
      content: [
        {
          type: "text",
          text: safeJsonStringify(result, 2),
        },
      ],
    };
  } catch (error: any) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Failed to inspect schema: ${error?.message || String(error)}`,
        },
      ],
    };
  }
}

/**
 * Registra a ferramenta `inspect_schema` no McpServer (SDK STDIO)
 */
export function registerInspectSchemaTool(server: any, context: McpConnectionContext): void {
  server.tool(
    "inspect_schema",
    "Inspeciona o catálogo e esquema de tabelas de uma conexão de forma paginada e defensiva",
    InspectSchemaInputSchema.shape,
    async (args: InspectSchemaInput) => {
      return executeInspectSchema(args, context);
    },
  );
}
