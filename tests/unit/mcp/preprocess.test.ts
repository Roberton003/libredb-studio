/**
 * The pre-processing of an authenticated POST to /api/mcp (#246), step 0: one slot of the query
 * bucket per POST, keyed on the user the token was minted for, spent before the body is read.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { logger } from "@/lib/logger";
import { preprocessMcpPost } from "@/lib/mcp/preprocess";
import { MCP_TEST_URL, testAuthInfo } from "../../helpers/mcp-harness";

const alice = testAuthInfo({ username: "alice", role: "admin" });
const bob = testAuthInfo({ username: "bob", role: "user" });

function post(): Request {
  return new Request(MCP_TEST_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

/** A POST whose body stream fails the moment anything reads it. */
function unreadablePost(): Request {
  const body = new ReadableStream({
    pull() {
      throw new Error("the body was read");
    },
  });
  return new Request(MCP_TEST_URL, { method: "POST", headers: { "content-type": "application/json" }, body });
}

const lines = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);

beforeEach(() => {
  clearRateLimitState();
  process.env.RATE_LIMIT_QUERY_MAX = "1";
});

afterEach(() => {
  clearRateLimitState();
  delete process.env.RATE_LIMIT_QUERY_MAX;
});

describe("step 0, the query budget", () => {
  test("dispatches an allowed POST with its body unread", async () => {
    const request = post();
    expect(await preprocessMcpPost(request, alice)).toEqual({
      kind: "dispatch",
      parsedBody: undefined,
      invalidArgumentsTool: null,
    });
    expect(request.bodyUsed).toBe(false);
  });

  test("answers the POST after the budget with the repository's 429 and Retry-After, without reading the body", async () => {
    await preprocessMcpPost(post(), alice);
    const request = unreadablePost();
    const outcome = await preprocessMcpPost(request, alice);
    if (outcome.kind !== "refused") throw new Error("the second POST should have been refused");
    expect(outcome.response.status).toBe(429);
    expect(Number(outcome.response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await outcome.response.json()).toMatchObject({ code: "RATE_LIMITED", statusCode: 429, retryable: true });
    expect(request.bodyUsed).toBe(false);
  });

  test("writes one rate_limit_exceeded event on the trip, and none for the 429s after it", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      for (let i = 0; i < 4; i += 1) await preprocessMcpPost(post(), alice);
      const trips = lines(spy).filter((line) => line.event === "rate_limit_exceeded");
      expect(trips).toHaveLength(1);
      expect(trips[0]).toMatchObject({
        actor: "alice",
        bucket: "query",
        route: "POST /api/mcp",
        reason: "rate_limited",
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("still answers 429 when the audit sink throws, and logs the failure once", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    const errorLog = spyOn(logger, "error").mockImplementation(() => {});
    try {
      await preprocessMcpPost(post(), alice);
      const outcome = await preprocessMcpPost(post(), alice);
      expect(outcome.kind === "refused" ? outcome.response.status : 0).toBe(429);
      expect(errorLog).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
      errorLog.mockRestore();
    }
  });

  test("is kept per user", async () => {
    await preprocessMcpPost(post(), alice);
    expect((await preprocessMcpPost(post(), alice)).kind).toBe("refused");
    expect((await preprocessMcpPost(post(), bob)).kind).toBe("dispatch");
  });

  test("RATE_LIMIT_QUERY_MAX=0 means unlimited", async () => {
    process.env.RATE_LIMIT_QUERY_MAX = "0";
    for (let i = 0; i < 10; i += 1) expect((await preprocessMcpPost(post(), alice)).kind).toBe("dispatch");
  });
});
