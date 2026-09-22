import { z } from "zod";
import type { DatabaseConnection } from "@/lib/db/types";

// ============================================================================
// Schemas e Tipos para list_connections
// ============================================================================

export const ListConnectionsInputSchema = z.object({
  environment: z.enum(["all", "development", "staging", "production", "local", "other"]).optional().default("all"),
});

export type ListConnectionsInput = z.infer<typeof ListConnectionsInputSchema>;

export interface PublicConnectionMetadata {
  id: string;
  name: string;
  engine: string;
  database?: string;
  read_only: boolean;
  environment?: string;
}

// ============================================================================
// Schemas e Tipos para inspect_schema
// ============================================================================

export const InspectSchemaInputSchema = z.object({
  connection_id: z.string().min(1, "connection_id é obrigatório"),
  schema: z.string().optional(),
  table: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
  include_columns: z.boolean().default(true),
  include_indexes: z.boolean().default(false),
});

export type InspectSchemaInput = z.infer<typeof InspectSchemaInputSchema>;

export interface SchemaInspectionResult {
  connection_id: string;
  schema: string;
  total_tables: number;
  limit: number;
  offset: number;
  has_more: boolean;
  tables: Array<{
    name: string;
    kind: "table" | "view" | "materialized_view";
    comment?: string;
    columns?: Array<{
      name: string;
      data_type: string;
      is_nullable: boolean;
      default_value?: string | null;
      is_primary_key: boolean;
      comment?: string;
    }>;
    indexes?: Array<{
      name: string;
      columns: string[];
      is_unique: boolean;
    }>;
  }>;
}

// ============================================================================
// Schemas e Tipos para run_read_query
// ============================================================================

export const RunReadQueryInputSchema = z.object({
  connection_id: z.string().min(1, "connection_id é obrigatório"),
  sql: z.string().min(1, "SQL não pode ser vazio"),
  max_rows: z.number().int().min(1).max(500).default(100),
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

// ============================================================================
// Configuração do Servidor MCP
// ============================================================================

export interface McpServerConfig {
  serverName?: string;
  serverVersion?: string;
  connections?: DatabaseConnection[];
  connectionsProvider?: () => Promise<DatabaseConnection[]> | DatabaseConnection[];
  defaultQueryTimeoutMs?: number;
  maxQueryRowsCeiling?: number;
}

// ============================================================================
// Protocolo JSON-RPC 2.0 & MCP
// ============================================================================

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

export const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolContent {
  type: "text";
  text: string;
}

export interface McpCallResult {
  content: McpToolContent[];
  isError?: boolean;
}
