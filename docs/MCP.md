# MCP

LibreDB Studio exposes a native HTTP JSON-RPC MCP endpoint.

## Endpoint

Use the `/api/mcp` path on your deployment:

```text
https://<your-libredb-studio-host>/api/mcp
```

The endpoint requires an authenticated LibreDB Studio session. There is no separate MCP token and no STDIO server. Never commit session cookies or other credentials.

## Available tools

- `list_connections` — list available connections without exposing credentials.
- `inspect_schema` — inspect schemas, tables, columns, and indexes.
- `run_read_query` — execute a read-only `SELECT` or `WITH` query subject to row, payload, and timeout limits.

Engine profile restrictions are enforced. If an engine refuses the requested read-only or operations profile, the refusal is returned to the MCP client; Studio does not silently switch to a writable provider.

## Cursor

Add LibreDB Studio as an HTTP MCP server using the configuration format supported by your installed Cursor version. Set the server URL to the endpoint above and use Cursor's documented secure authentication/session mechanism. Consult the current Cursor MCP documentation for exact keys and authentication behavior: <https://docs.cursor.com/context/mcp>.

## Claude Code

Add the endpoint as an HTTP MCP server using the configuration format supported by your installed version. Use the endpoint URL above and the documented secure session mechanism. Do not place a LibreDB Studio session cookie in a checked-in configuration file. Consult the current Claude Code MCP documentation for exact configuration details.

## OpenCode

Add the endpoint as a remote HTTP MCP server using the configuration format supported by your installed version. Use the endpoint URL above and OpenCode's documented secure authentication mechanism. Consult the current OpenCode MCP documentation for exact configuration details.

## Security and troubleshooting

- Use HTTPS in production and restrict network access to trusted clients.
- Use a least-privilege Studio account.
- Never commit cookies, bearer credentials, or generated client configuration containing secrets.
- Unauthenticated requests through Studio reverse proxy/middleware receive an HTTP 307 redirect to `/login`. Direct calls without a valid session cookie receive `401 Authentication required`.
- `429` indicates the query rate limit bucket was reached.
- Batch requests are supported up to 50 requests per batch with a 64 KiB wire budget. If a batch exceeds the budget, overflowing responses are returned with per-ID JSON-RPC errors rather than silently dropped.
- The `offset` parameter in `run_read_query` is supported when the underlying provider declares pagination support (`supportsResultPagination`). A positive offset on an unsupported provider returns an error. Deterministic ordering (`ORDER BY`) is recommended for stable pagination.
- Engine operations write structured audit events (`type: agent_operation`) with duration and user identity without exposing query text or credential secrets.
- A JSON-RPC error generally indicates an invalid request, invalid parameters, unsupported method, or engine refusal.
