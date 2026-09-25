import { describe, expect, test } from "bun:test";
import { executeRunReadQuery } from "@/lib/mcp/tools/run-read-query";
import type { McpConnectionContext } from "@/lib/mcp/context";

describe("MCP Progressive Budget Compression (64 KiB Defensive)", () => {
  const createMockContext = (rows: any[], fields: string[]): McpConnectionContext => {
    const mockProvider = {
      readOnlyProfile: true,
      prepareQuery: (sql: string, options: any) => ({
        query: sql,
        limit: options.limit,
        offset: 0,
        wasLimited: false,
      }),
      queryReadOnly: async () => ({ rows, fields }),
    };

    return {
      getProvider: async () => mockProvider,
    } as unknown as McpConnectionContext;
  };

  test("respects 64 KiB ceiling even when query returns 10,000 columns in metadata", async () => {
    const fields = Array.from({ length: 10000 }, (_, i) => `column_${i}`);
    const rows = [{ column_0: "test-value" }];
    const ctx = createMockContext(rows, fields);

    const result = await executeRunReadQuery({ connection_id: "test-conn", sql: "SELECT * FROM wide_table" }, ctx);

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    const envelope = JSON.parse(text);

    const wireBytes = Buffer.byteLength(text, "utf-8");
    expect(wireBytes).toBeLessThanOrEqual(64 * 1024);
    expect(envelope.truncated).toBe(true);
    expect(envelope.fields.length).toBeLessThanOrEqual(51);
  });

  test("truncates deep nested JSON objects preventing excessive payload", async () => {
    const giantPayload = { nested: "X".repeat(200000) };
    const rows = [{ id: 1, payload: giantPayload }];
    const ctx = createMockContext(rows, ["id", "payload"]);

    const result = await executeRunReadQuery(
      { connection_id: "test-conn", sql: "SELECT id, payload FROM json_table" },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    const envelope = JSON.parse(text);

    const wireBytes = Buffer.byteLength(text, "utf-8");
    expect(wireBytes).toBeLessThanOrEqual(64 * 1024);
    expect(envelope.truncated).toBe(true);
    expect(typeof envelope.rows[0].payload).toBe("string");
    expect(envelope.rows[0].payload).toContain("[TRUNCATED OBJECT]");
  });

  test("does not truncate queries that easily fit within budget", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      name: `User ${i + 1}`,
      active: true,
    }));
    const ctx = createMockContext(rows, ["id", "name", "active"]);

    const result = await executeRunReadQuery({ connection_id: "test-conn", sql: "SELECT * FROM users" }, ctx);

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    const envelope = JSON.parse(text);

    expect(envelope.truncated).toBe(false);
    expect(envelope.row_count).toBe(10);
    expect(envelope.rows.length).toBe(10);
  });

  test("respects 64 KiB ceiling even with giant column names and pathological keys", async () => {
    // 5 columns with names of 50,000 characters each
    const giantColName = "col_".repeat(12500);
    const fields = [giantColName];
    const rows = [{ [giantColName]: "short-val" }];
    const ctx = createMockContext(rows, fields);

    const result = await executeRunReadQuery({ connection_id: "test-conn", sql: "SELECT * FROM giant_cols" }, ctx);

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    const envelope = JSON.parse(text);

    const wireBytes = Buffer.byteLength(text, "utf-8");
    expect(wireBytes).toBeLessThanOrEqual(64 * 1024);
    expect(envelope.byte_size).toBe(wireBytes);
    expect(envelope.truncated).toBe(true);
  });

  test("guarantees exact match between envelope.byte_size and real serialized wire bytes (no undercounting)", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      id: i,
      name: `Entity ${i}`,
      description: `Description text for entity ${i} with some variable padding: ${"#".repeat(i * 10)}`,
    }));
    const ctx = createMockContext(rows, ["id", "name", "description"]);

    const result = await executeRunReadQuery({ connection_id: "test-conn", sql: "SELECT * FROM entities" }, ctx);

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    const envelope = JSON.parse(text);

    const wireBytes = Buffer.byteLength(text, "utf-8");
    expect(envelope.byte_size).toBe(wireBytes);
  });
});
