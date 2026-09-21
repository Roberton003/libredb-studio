/**
 * Serializador seguro para o protocolo MCP.
 * Previne crashes em runtime causados por tipos nativos de banco de dados (BigInt, Buffers, Datas, ciclos).
 */

function serializeValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  // Tratamento de BigInt (PostgreSQL int8, SQLite 64-bit int)
  if (typeof value === "bigint") {
    return value.toString();
  }

  // Tratamento de números não-finitos
  if (typeof value === "number") {
    if (Number.isNaN(value) || !Number.isFinite(value)) {
      return null;
    }
    return value;
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  // Tratamento de Datas (incluindo prevenção de crash com Invalid Date)
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  // Tratamento de Buffers e dados binários (BLOBs)
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `[Blob: ${value.length} bytes]`;
  }

  // Tratamento de Erros
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }

  // Tratamento de Objetos e Arrays com prevenção de ciclos e getters hostis
  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((item) => serializeValue(item, seen));
    }

    const result: Record<string, unknown> = {};
    try {
      for (const [k, v] of Object.entries(value)) {
        result[k] = serializeValue(v, seen);
      }
    } catch {
      return String(value);
    }
    return result;
  }

  return String(value);
}

/**
 * Converte qualquer estrutura de dados retornado por drivers SQL para um objeto JSON-safe.
 */
export function safeSerialize<T>(data: T): T {
  return serializeValue(data) as T;
}

/**
 * Serializa dados de consulta para JSON sem risco de lançar TypeError (ex: BigInt).
 */
export function safeJsonStringify(data: unknown, space?: number): string {
  const safeData = safeSerialize(data);
  return JSON.stringify(safeData, null, space);
}
