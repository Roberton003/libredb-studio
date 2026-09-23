import { describe, expect, test } from "bun:test";
import { safeJsonStringify, safeSerialize, redactErrorMessage, redactError } from "@/lib/mcp/serializer";

describe("MCP Safe Serializer", () => {
  test("serializa BigInt para string sem lançar TypeError", () => {
    const raw = {
      id: BigInt("9007199254740993"),
      normal: 42,
    };

    const serialized = safeSerialize(raw) as any;
    expect(serialized.id).toBe("9007199254740993");
    expect(serialized.normal).toBe(42);

    const json = safeJsonStringify(raw);
    expect(json).toContain('"id":"9007199254740993"');
  });

  test("serializa Buffers e Uint8Array para identificador seguro de Blob", () => {
    const raw = {
      avatar: Buffer.from("conteudo binario fake"),
      binaryData: new Uint8Array([1, 2, 3, 4]),
    };

    const serialized = safeSerialize(raw) as any;
    expect(serialized.avatar).toContain("[Blob:");
    expect(serialized.binaryData).toBe("[Blob: 4 bytes]");
  });

  test("serializa Date para string ISO", () => {
    const d = new Date("2026-09-20T21:00:00.000Z");
    const raw = { created_at: d };
    const serialized = safeSerialize(raw) as any;
    expect(serialized.created_at).toBe("2026-09-20T21:00:00.000Z");
  });

  test("trata números não-finitos (NaN, Infinity)", () => {
    const raw = {
      valNan: Number.NaN,
      valInf: Number.POSITIVE_INFINITY,
    };
    const serialized = safeSerialize(raw);
    expect(serialized.valNan).toBeNull();
    expect(serialized.valInf).toBeNull();
  });

  test("previne estouro por referência circular", () => {
    const obj: any = { name: "circulo" };
    obj.self = obj;

    const serialized = safeSerialize(obj);
    expect(serialized.self).toBe("[Circular]");
    expect(() => safeJsonStringify(obj)).not.toThrow();
  });

  test("trata Invalid Date retornando null sem lançar RangeError", () => {
    const invalidDate = new Date("data-invalida-que-gera-nan");
    const raw = { badDate: invalidDate };
    const serialized = safeSerialize(raw) as any;
    expect(serialized.badDate).toBeNull();
    expect(() => safeJsonStringify(raw)).not.toThrow();
  });

  test("trata objetos com getters que lançam erro ou proxies hostis sem quebrar o serializador", () => {
    const hostile: any = {};
    Object.defineProperty(hostile, "explosive", {
      get() {
        throw new Error("Getters hostis interceptados");
      },
      enumerable: true,
    });

    expect(() => safeSerialize(hostile)).not.toThrow();
    expect(safeSerialize(hostile)).toBe("[object Object]");
  });

  test("serializa Error para objeto com name e message", () => {
    const err = new Error("Falha de teste");
    const serialized = safeSerialize(err) as any;
    expect(serialized.name).toBe("Error");
    expect(serialized.message).toBe("Falha de teste");
  });

  test("redactErrorMessage mascara senhas, tokens e credenciais em URIs", () => {
    expect(redactErrorMessage("Failed to connect: password=test_password to host")).toBe(
      "Failed to connect: password=[REDACTED] to host",
    );
    expect(redactErrorMessage("Invalid token: token=test_token_value")).toBe("Invalid token: token=[REDACTED]");
    expect(redactErrorMessage("Connect to postgres://user:test_password@localhost:5432/db failed")).toBe(
      "Connect to postgres://[REDACTED]@localhost:5432/db failed",
    );
    expect(
      redactErrorMessage(
        "Error at https://db.internal:5432/query?token=test_query_token&env=staging with bearer test_bearer_token",
      ),
    ).toBe("Error at https://db.internal:5432/query?token=[REDACTED]&env=staging with bearer [REDACTED]");
    expect(redactErrorMessage("api_key: test_api_key")).toBe("api_key: [REDACTED]");
    expect(
      redactErrorMessage("https://db.invalid/?client_secret=test_client_secret&refresh_token=test_refresh_token"),
    ).toBe("https://db.invalid/?client_secret=[REDACTED]&refresh_token=[REDACTED]");
    expect(redactErrorMessage("")).toBe("Unknown error");
  });

  test("redactErrorMessage é imune a ReDoS em strings com repetições longas de caracteres", () => {
    const attackPayload = "A".repeat(50000);
    const start = performance.now();
    const result = redactErrorMessage(attackPayload);
    const duration = performance.now() - start;
    expect(result).toBe(attackPayload);
    expect(duration).toBeLessThan(100);
  });

  test("redactError sanitiza message e stack de instâncias de Error", () => {
    const rawError = new Error("Database auth failure: password=test_password and token=test_token_value");
    rawError.name = "DatabaseAuthError";

    const safe = redactError(rawError);
    expect(safe).toBeInstanceOf(Error);
    expect(safe.name).toBe("DatabaseAuthError");
    expect(safe.message).not.toContain("test_password");
    expect(safe.message).not.toContain("test_token_value");
    expect(safe.message).toBe("Database auth failure: password=[REDACTED] and token=[REDACTED]");
    if (safe.stack) {
      expect(safe.stack).not.toContain("test_password");
      expect(safe.stack).not.toContain("test_token_value");
    }

    const safeFromString = redactError("Critical failure: password=test_password");
    expect(safeFromString).toBeInstanceOf(Error);
    expect(safeFromString.message).toBe("Critical failure: password=[REDACTED]");
  });
});
