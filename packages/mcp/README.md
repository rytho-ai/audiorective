# @audiorective/mcp

An MCP stdio server that lets an AI agent drive an audiorective DAW page. It holds no DAW logic: it opens a WebSocket server, waits for the page to connect, and relays `tools/list` and `tools/call` to the page's `mcpTools`. See [docs/mcp.md](../../docs/mcp.md) for the tools.

## Setup

1. Register the server with your agent. It listens on `127.0.0.1:7777` by default (`--port` changes it).

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

## Bridge protocol

JSON text frames. Server to page: `{ id, method: "list" }` and `{ id, method: "call", name, args }`. Page to server: `{ id, result }` or `{ id, error }`; `list` returns `[{ name, description, inputSchema }]` and `call` returns `{ content, isError? }`.
