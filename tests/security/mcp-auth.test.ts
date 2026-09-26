/**
 * The MCP endpoint's identity boundary (#246).
 *
 * Every /api/mcp request presents a scoped bearer token, and the Studio session cookie opens
 * nothing on this path: a refusal is a 401 with WWW-Authenticate and no redirect, and it is
 * audited on the stdout channel, metered through the anon bucket. Driven through the real
 * proxy() here; the route's own half of the boundary is below it. Every request carries an
 * explicit Host and HOSTNAME is fixed, as csrf-origin.test.ts builds requests.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { SignJWT } from "jose";
import { NextRequest } from "next/server";
import { AGENT_DRIVE_HEADER, AGENT_DRIVE_PATH, mintAgentDriveToken } from "@/lib/agent/drive-token";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { signJWT } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { proxy } from "@/proxy";
import { withBasePathEnv } from "../helpers/base-path";
import { pinMcpTestEnvironment } from "../helpers/mcp-fixtures";
import { mintTestToken, useMcpChannel } from "../helpers/mcp-token";
import { mcpRequest, permissionDeniedLines } from "./helpers/mcp-requests";

pinMcpTestEnvironment();

let restoreChannel: () => void = () => {};

beforeEach(() => {
  clearRateLimitState();
  restoreChannel = useMcpChannel();
});

afterEach(() => {
  restoreChannel();
  clearRateLimitState();
});

/** A session JWT the session key signed an hour past its exp, as tests/api/proxy.test.ts builds one. */
async function expiredSession(): Promise<string> {
  return new SignJWT({ username: "alice", role: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("-1h")
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
}

const expectChallenge = async (response: Response, description: string) => {
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toStartWith('Bearer error="invalid_token"');
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await response.json()).toEqual({ error: "invalid_token", error_description: description });
};

describe("through proxy(), a request to /api/mcp", () => {
  test("without Authorization gets 401, the challenge, a JSON body and no Location", async () => {
    await expectChallenge(await proxy(mcpRequest("POST")), "Missing Authorization header");
  });

  test("with a valid session cookie and no bearer gets 401, not the session", async () => {
    const cookie = await signJWT({ username: "alice", role: "admin" });
    await expectChallenge(
      await proxy(mcpRequest("POST", { cookie: `auth-token=${cookie}` })),
      "Missing Authorization header",
    );
  });

  test("with a valid session cookie and an invalid bearer gets 401", async () => {
    const cookie = await signJWT({ username: "alice", role: "admin" });
    const response = await proxy(
      mcpRequest("POST", { cookie: `auth-token=${cookie}`, authorization: "Bearer forged-token-written-in-words" }),
    );
    await expectChallenge(response, "The MCP token is invalid, expired or revoked");
  });

  test("with a forged or an expired cookie and no bearer gets 401", async () => {
    for (const cookie of ["forged-cookie-written-in-words", await expiredSession()]) {
      await expectChallenge(
        await proxy(mcpRequest("POST", { cookie: `auth-token=${cookie}` })),
        "Missing Authorization header",
      );
    }
  });

  test("with a session JWT sent as the bearer gets 401", async () => {
    const session = await signJWT({ username: "alice", role: "admin" });
    await expectChallenge(
      await proxy(mcpRequest("POST", { authorization: `Bearer ${session}` })),
      "The MCP token is invalid, expired or revoked",
    );
  });

  test("with a drive token sent as the bearer gets 401", async () => {
    const drive = await mintAgentDriveToken("arun_0123456789abcdef");
    expect((await proxy(mcpRequest("POST", { authorization: `Bearer ${drive}` }))).status).toBe(401);
  });

  test("ignores a token in the query string", async () => {
    expect((await proxy(mcpRequest("POST", {}, `/api/mcp?access_token=${await mintTestToken()}`))).status).toBe(401);
  });

  test("with a valid bearer passes to the route", async () => {
    const response = await proxy(mcpRequest("POST", { authorization: `Bearer ${await mintTestToken()}` }));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  test("from a foreign Origin as a POST gets checkOrigin's 403 before the bearer is read", async () => {
    const response = await proxy(mcpRequest("POST", { origin: "https://evil.example" }));
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("ORIGIN_MISMATCH");
  });

  test("under a nested basePath gets the same answers", async () => {
    await withBasePathEnv("/tools/libredb", async () => {
      const build = (headers: Record<string, string>) =>
        new NextRequest("http://localhost:3000/tools/libredb/api/mcp", {
          nextConfig: { basePath: "/tools/libredb" },
          method: "POST",
          headers: { host: "localhost:3000", "content-type": "application/json", ...headers },
          body: "{}",
        });
      const bare = build({});
      expect(bare.nextUrl.pathname).toBe("/api/mcp");
      expect((await proxy(bare)).status).toBe(401);
      const admitted = await proxy(build({ authorization: `Bearer ${await mintTestToken()}` }));
      expect(admitted.headers.get("x-middleware-next")).toBe("1");
    });
  });
});

describe("through proxy(), the rest of the application", () => {
  test("still redirects /api/db/query without a cookie to /login", async () => {
    const response = await proxy(
      new NextRequest("http://localhost:3000/api/db/query", { headers: { host: "localhost:3000" } }),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/login");
  });

  test("does not open the drive path for an MCP token", async () => {
    const request = new NextRequest(`http://localhost:3000${AGENT_DRIVE_PATH}`, {
      headers: { host: "localhost:3000" },
    });
    request.headers.set(AGENT_DRIVE_HEADER, await mintTestToken());
    expect((await proxy(request)).status).toBe(307);
  });
});

describe("through proxy(), a refusal on /api/mcp is audited", () => {
  test("a forged bearer writes one line: anonymous, mcp_token_invalid, POST /api/mcp", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await proxy(mcpRequest("POST", { authorization: "Bearer forged-token-written-in-words" }));
      expect(permissionDeniedLines(spy)).toEqual([
        expect.objectContaining({ actor: "anonymous", reason: "mcp_token_invalid", route: "POST /api/mcp" }),
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  test("a missing header writes the same reason, and a channel without a label writes mcp_channel_unconfigured", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await proxy(mcpRequest("POST"));
      restoreChannel();
      restoreChannel = useMcpChannel({ label: null });
      await proxy(mcpRequest("POST", { authorization: "Bearer any-bearer-written-in-words" }));
      expect(permissionDeniedLines(spy).map((line) => line.reason)).toEqual([
        "mcp_token_invalid",
        "mcp_channel_unconfigured",
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  test("a minted token while LIBREDB_MCP_URL is unset writes mcp_channel_unconfigured", async () => {
    const token = await mintTestToken();
    restoreChannel();
    restoreChannel = useMcpChannel({ url: null });
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect((await proxy(mcpRequest("POST", { authorization: `Bearer ${token}` }))).status).toBe(401);
      expect(permissionDeniedLines(spy).map((line) => line.reason)).toEqual(["mcp_channel_unconfigured"]);
    } finally {
      spy.mockRestore();
    }
  });

  test("the lines are bounded to RATE_LIMIT_ANON_MAX plus one per window, the 401s are not", async () => {
    process.env.RATE_LIMIT_ANON_MAX = "2";
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      for (let i = 0; i < 10; i += 1) expect((await proxy(mcpRequest("POST"))).status).toBe(401);
      expect(permissionDeniedLines(spy)).toHaveLength(3);
    } finally {
      spy.mockRestore();
      delete process.env.RATE_LIMIT_ANON_MAX;
    }
  });

  test("a valid cookie and no bearer writes one line", async () => {
    const cookie = await signJWT({ username: "alice", role: "admin" });
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await proxy(mcpRequest("POST", { cookie: `auth-token=${cookie}` }));
      expect(permissionDeniedLines(spy)).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("a throwing sink leaves the 401 unchanged", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    const errorLog = spyOn(logger, "error").mockImplementation(() => {});
    try {
      await expectChallenge(await proxy(mcpRequest("POST")), "Missing Authorization header");
    } finally {
      spy.mockRestore();
      errorLog.mockRestore();
    }
  });

  test("a verifier fault answers 500 server_error, logs once and writes no line", async () => {
    const env = process.env as Record<string, string | undefined>;
    const secret = env.JWT_SECRET;
    const mode = env.NODE_ENV;
    delete env.JWT_SECRET;
    env.NODE_ENV = "production";
    const spy = spyOn(console, "log").mockImplementation(() => {});
    const errorLog = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const response = await proxy(mcpRequest("POST", { authorization: "Bearer any-bearer-written-in-words" }));
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "server_error", error_description: "Internal Server Error" });
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(permissionDeniedLines(spy)).toEqual([]);
    } finally {
      spy.mockRestore();
      errorLog.mockRestore();
      env.JWT_SECRET = secret;
      env.NODE_ENV = mode;
    }
  });
});
