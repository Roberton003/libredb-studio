import { describe, expect, test } from "bun:test";
import { safeJsonStringify, safeSerialize } from "@/lib/mcp/serializer";

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
    const hostileObj = {};
    Object.defineProperty(hostileObj, "explodingProp", {
      get() {
        throw new Error("Acesso hostil bloqueado");
      },
      enumerable: true,
    });

    expect(() => safeSerialize(hostileObj)).not.toThrow();
    expect(() => safeJsonStringify(hostileObj)).not.toThrow();
  });
});
