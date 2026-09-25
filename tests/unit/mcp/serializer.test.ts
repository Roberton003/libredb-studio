import { describe, expect, test } from "bun:test";
import { safeJsonStringify, safeSerialize, redactErrorMessage, redactError } from "@/lib/mcp/serializer";

describe("MCP Safe Serializer", () => {
  test("serializes BigInt to string without throwing TypeError", () => {
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

  test("serializes Buffers and Uint8Array to safe Blob identifier", () => {
    const raw = {
      avatar: Buffer.from("fake binary content"),
      binaryData: new Uint8Array([1, 2, 3, 4]),
    };

    const serialized = safeSerialize(raw) as any;
    expect(serialized.avatar).toContain("[Blob:");
    expect(serialized.binaryData).toBe("[Blob: 4 bytes]");
  });

  test("serializes Date to ISO string", () => {
    const d = new Date("2026-09-20T21:00:00.000Z");
    const raw = { created_at: d };
    const serialized = safeSerialize(raw) as any;
    expect(serialized.created_at).toBe("2026-09-20T21:00:00.000Z");
  });

  test("handles non-finite numbers (NaN, Infinity)", () => {
    const raw = {
      valNan: Number.NaN,
      valInf: Number.POSITIVE_INFINITY,
    };
    const serialized = safeSerialize(raw);
    expect(serialized.valNan).toBeNull();
    expect(serialized.valInf).toBeNull();
  });

  test("prevents overflow on circular references", () => {
    const obj: any = { name: "circle" };
    obj.self = obj;

    const serialized = safeSerialize(obj);
    expect(serialized.self).toBe("[Circular]");
    expect(() => safeJsonStringify(obj)).not.toThrow();
  });

  test("handles Invalid Date by returning null without throwing RangeError", () => {
    const invalidDate = new Date("invalid-date-generating-nan");
    const raw = { badDate: invalidDate };
    const serialized = safeSerialize(raw) as any;
    expect(serialized.badDate).toBeNull();
    expect(() => safeJsonStringify(raw)).not.toThrow();
  });

  test("handles objects with throwing getters or hostile proxies without breaking serializer", () => {
    const hostile: any = {};
    Object.defineProperty(hostile, "explosive", {
      get() {
        throw new Error("Hostile getters intercepted");
      },
      enumerable: true,
    });

    expect(() => safeSerialize(hostile)).not.toThrow();
    expect(safeSerialize(hostile)).toBe("[object Object]");
  });

  test("serializes Error to object with name and message", () => {
    const err = new Error("Test failure");
    const serialized = safeSerialize(err) as any;
    expect(serialized.name).toBe("Error");
    expect(serialized.message).toBe("Test failure");
  });

  test("redactErrorMessage masks passwords, tokens, and credentials in URIs", () => {
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

  test("redactErrorMessage is resilient against ReDoS on long repeating character strings with scheme and userinfo", () => {
    const attackPayloadWithoutUserInfo = "http://" + "A".repeat(50000);
    const attackPayloadWithUserInfo = "http://" + "A".repeat(50000) + "@host.internal/db";

    const startWithout = performance.now();
    const resultWithout = redactErrorMessage(attackPayloadWithoutUserInfo);
    const durationWithout = performance.now() - startWithout;

    const startWith = performance.now();
    const resultWith = redactErrorMessage(attackPayloadWithUserInfo);
    const durationWith = performance.now() - startWith;

    expect(resultWithout).toBe(attackPayloadWithoutUserInfo);
    expect(resultWith).toBe("http://[REDACTED]@host.internal/db");
    expect(durationWithout).toBeLessThan(50);
    expect(durationWith).toBeLessThan(50);
  });

  test("redactError sanitizes message and stack of Error instances", () => {
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
