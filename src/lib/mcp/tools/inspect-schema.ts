import type { McpConnectionContext } from "../context";
import { safeJsonStringify } from "../serializer";
import { type InspectSchemaInput, InspectSchemaInputSchema, type SchemaInspectionResult } from "../types";

/**
 * Registra a ferramenta `inspect_schema` no McpServer
 */
export function registerInspectSchemaTool(server: any, context: McpConnectionContext): void {
  server.tool(
    "inspect_schema",
    "Inspeciona o catálogo e esquema de tabelas de uma conexão de forma paginada e defensiva",
    InspectSchemaInputSchema.shape,
    async (args: InspectSchemaInput) => {
      try {
        const provider = await context.getProvider(args.connection_id);

        // 1. Determinar o container (schema/catalog)
        const containers = await provider.listContainers();

        let targetContainer: (typeof containers)[0] | undefined;
        if (args.schema) {
          targetContainer = containers.find((c) => c.name.toLowerCase() === args.schema?.toLowerCase());
          if (!targetContainer) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Schema "${args.schema}" not found in connection "${args.connection_id}".`,
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
        const filteredObjects = args.table
          ? allObjects.filter((o) => o.name.toLowerCase() === args.table?.toLowerCase())
          : allObjects;

        const totalTables = filteredObjects.length;
        const paginatedObjects = filteredObjects.slice(args.offset, args.offset + args.limit);
        const hasMore = args.offset + args.limit < totalTables;

        const tablesDetails: SchemaInspectionResult["tables"] = [];

        for (const obj of paginatedObjects) {
          let columns: SchemaInspectionResult["tables"][0]["columns"] | undefined;
          let indexes: SchemaInspectionResult["tables"][0]["indexes"] | undefined;
          let comment: string | undefined;

          if (args.include_columns || args.include_indexes) {
            try {
              const detail = await provider.describeObject(obj.path, "table");

              if (args.include_columns && detail.columns) {
                columns = detail.columns.map((c) => ({
                  name: c.name,
                  data_type: c.type,
                  is_nullable: c.nullable ?? true,
                  default_value: c.defaultValue !== undefined ? String(c.defaultValue) : null,
                  is_primary_key: Boolean(c.isPrimary),
                }));
              }

              if (args.include_indexes && detail.indexes) {
                indexes = detail.indexes.map((idx) => ({
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
          connection_id: args.connection_id,
          schema: targetContainer ? targetContainer.name : "default",
          total_tables: totalTables,
          limit: args.limit,
          offset: args.offset,
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
    },
  );
}
