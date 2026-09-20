/**
 * Unit tests for MariaDB and MySQL column default normalization (#795).
 * Pins the behavior of normalizeColumnDefault and isMariaDB against all measured cases.
 */

import { describe, test, expect } from "bun:test";
import { normalizeColumnDefault, isMariaDB } from "@/lib/db/providers/sql/mysql";

describe("isMariaDB (#795)", () => {
  test("identifies MariaDB from VERSION() strings", () => {
    expect(isMariaDB("12.3.2-MariaDB-ubu2404")).toBe(true);
    expect(isMariaDB("10.11.8-MariaDB-1:10.11.8+maria~ubu2204")).toBe(true);
    expect(isMariaDB("13.0.2-MariaDB")).toBe(true);
    expect(isMariaDB("mariadb.org binary distribution")).toBe(true);
  });

  test("does not classify MySQL or other wire-compatible engines as MariaDB", () => {
    expect(isMariaDB("8.0.36")).toBe(false);
    expect(isMariaDB("26.7.0")).toBe(false);
    expect(isMariaDB("5.7.44")).toBe(false);
    expect(isMariaDB("8.5.1-TiDB")).toBe(false);
    expect(isMariaDB("SingleStore 8.4.1")).toBe(false);
    expect(isMariaDB("Vitess 18.0.0")).toBe(false);
    expect(isMariaDB(undefined)).toBe(false);
  });
});

describe("normalizeColumnDefault (#795)", () => {
  describe("MySQL and wire-compatible derivatives (isMaria = false)", () => {
    test("returns undefined for null or undefined input", () => {
      expect(normalizeColumnDefault(null, null, false)).toBeUndefined();
      expect(normalizeColumnDefault(undefined, undefined, false)).toBeUndefined();
    });

    test("passes evaluated values through as-is", () => {
      expect(normalizeColumnDefault("abc", null, false)).toBe("abc");
      expect(normalizeColumnDefault("0.00", null, false)).toBe("0.00");
      expect(normalizeColumnDefault("42", null, false)).toBe("42");
      expect(normalizeColumnDefault("NULL", null, false)).toBe("NULL");
      expect(normalizeColumnDefault("CURRENT_TIMESTAMP", null, false)).toBe("CURRENT_TIMESTAMP");
      expect(normalizeColumnDefault("", null, false)).toBe("");
    });

    test("ignores EXTRA on non-MariaDB engines", () => {
      expect(normalizeColumnDefault("42", "DEFAULT_GENERATED", false)).toBe("42");
      expect(normalizeColumnDefault("NULL", "STORED GENERATED", false)).toBe("NULL");
    });
  });

  describe("MariaDB dialect (isMaria = true)", () => {
    test("returns undefined for null or undefined input", () => {
      expect(normalizeColumnDefault(null, null, true)).toBeUndefined();
      expect(normalizeColumnDefault(undefined, undefined, true)).toBeUndefined();
    });

    test("maps bare unquoted 'NULL' to undefined (nullable column with no default)", () => {
      expect(normalizeColumnDefault("NULL", null, true)).toBeUndefined();
      expect(normalizeColumnDefault("NULL", "", true)).toBeUndefined();
    });

    test("maps generated columns to undefined regardless of raw value", () => {
      expect(normalizeColumnDefault("NULL", "STORED GENERATED", true)).toBeUndefined();
      expect(normalizeColumnDefault("NULL", "VIRTUAL GENERATED", true)).toBeUndefined();
      expect(normalizeColumnDefault("42", "STORED GENERATED", true)).toBeUndefined();
    });

    test("unquotes and unescapes string literals", () => {
      // String literal whose value is 'NULL'
      expect(normalizeColumnDefault("'NULL'", null, true)).toBe("NULL");

      // Regular string literals
      expect(normalizeColumnDefault("'abc'", null, true)).toBe("abc");
      expect(normalizeColumnDefault("''", null, true)).toBe("");

      // Single quotes escaped via doubling ('' -> ')
      expect(normalizeColumnDefault("'it''s'", null, true)).toBe("it's");
      expect(normalizeColumnDefault("'NULL'''", null, true)).toBe("NULL'");

      // Single quotes escaped via backslash (\' -> ')
      expect(normalizeColumnDefault("'foo\\'bar'", null, true)).toBe("foo'bar");
    });

    test("passes numeric literals and expressions through without stripping", () => {
      expect(normalizeColumnDefault("42", null, true)).toBe("42");
      expect(normalizeColumnDefault("1", null, true)).toBe("1");
      expect(normalizeColumnDefault("3.1415", null, true)).toBe("3.1415");
      expect(normalizeColumnDefault("current_timestamp()", null, true)).toBe("current_timestamp()");
      expect(normalizeColumnDefault("concat('x','y')", null, true)).toBe("concat('x','y')");
      expect(normalizeColumnDefault("uuid()", null, true)).toBe("uuid()");
    });
  });
});
