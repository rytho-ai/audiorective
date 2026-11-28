# @audiorective/mcp

An MCP stdio server that lets an AI agent drive an audiorective DAW page. It holds no DAW logic: it opens a WebSocket server, waits for the page to connect, and relays `tools/list` and `tools/call` to the page's `mcpTools`. See [docs/mcp.md](../../docs/mcp.md) for the tools.

## Setup

1. Register the server with your agent. It listens on `127.0.0.1:7777` by default (`--port` changes it). No token is needed by default (see Security).

```sh
claude mcp add audiorective -- npx -y @audiorective/mcp --port 7777
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.audiorective]
command = "npx"
args = ["-y", "@audiorective/mcp", "--port", "7777"]
```

2. In the page, serve the tools over the bridge:

```ts
import { mcpTools, connectMcpBridge } from "@audiorective/daw/mcp";

const tools = mcpTools(workspace, { save: (bytes, name) => download(new Blob([bytes]), name) });
connectMcpBridge(tools, "ws://127.0.0.1:7777"); // reconnects until the server is up
```

`tools/list` waits up to 10 seconds for a page to connect (`--wait-ms 10000` changes it), then answers with an empty list; the server declares `tools.listChanged` and sends `notifications/tools/list_changed` when a page connects or disconnects, so an agent that listed early sees the tools afterwards. `tools/call` without a page returns an error saying no page is connected. A newer page replaces the older one: the server closes the old page's socket with code `4000` (`replaced by another page`) and `connectMcpBridge` does not reconnect on it, so two open pages do not flap. A page that is connected but fails `tools/list` makes it fail with the page's message rather than return an empty list. A call that the page does not answer within 120 seconds fails.

## Security

A web page the person has open can open a WebSocket to `localhost` too, so the server only accepts a page that connects from an allowed origin (browsers set `Origin` on the handshake and pages cannot forge it); anything else gets HTTP 403 before a frame and one stderr line naming the origin. Allowed origins default to `http://localhost:*`, `http://127.0.0.1:*` and `http://[::1]:*` (any port); add more with `--allow-origin <origin>` (repeatable; `scheme://host:*` is any port). A client that sends no `Origin` is refused unless `--allow-missing-origin`. A pairing token is optional defence in depth, worth adding when the page is served from a non-loopback origin or the machine is shared: `--token <token>` (22 or more of `A-Za-z0-9_-`), `AUDIORECTIVE_MCP_TOKEN`, or `--token auto` to make and print one; the page then calls `connectMcpBridge(tools, url, { token })`, and the token travels as a WebSocket subprotocol, never in the URL. Limit what the agent may do with `mcpTools(workspace, { allow })`. Details: [docs/mcp.md](../../docs/mcp.md#security-and-permissions).

## Bridge protocol

JSON text frames. Server to page: `{ id, method: "list" }` and `{ id, method: "call", name, args }`. Page to server: `{ id, result }` or `{ id, error }`; `list` returns `[{ name, description, inputSchema }]` and `call` returns `{ content, isError? }`.
