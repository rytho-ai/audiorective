#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PageBridge, createMcpServer, createToken } from "./index";

/** The values of a flag that may repeat, as `--name value` or `--name=value`. */
function readValues(argv: string[], name: string): string[] {
  const values: string[] = [];
  argv.forEach((arg, at) => {
    if (arg === name) values.push(argv[at + 1] ?? "");
    else if (arg.startsWith(`${name}=`)) values.push(arg.slice(name.length + 1));
  });
  return values;
}

function readWaitMs(argv: string[]): number {
  const raw = readValues(argv, "--wait-ms")[0];
  if (raw === undefined) return 10_000;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms < 0) {
    console.error(`audiorective-mcp: --wait-ms needs a number of milliseconds, got "${raw}".`);
    process.exit(2);
  }
  return ms;
}

function readPort(argv: string[]): number {
  const raw = readValues(argv, "--port")[0];
  if (raw === undefined) return 7777;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`audiorective-mcp: --port needs a number from 0 to 65535, got "${raw}".`);
    process.exit(2);
  }
  return port;
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.error(
    [
      "Usage: audiorective-mcp [--port 7777] [--wait-ms 10000] [--allow-origin <origin>]... [--allow-missing-origin] [--token <token>|auto]",
      "MCP stdio server; the audiorective page connects to ws://127.0.0.1:<port>.",
      "  --allow-origin <origin>   a page origin that may connect (repeat it); `scheme://host:*` allows any port.",
      "                            Default: http://localhost:*, http://127.0.0.1:*, http://[::1]:*.",
      "  --allow-missing-origin    also accept a client that sends no Origin header (a script, not a browser).",
      "  --token <token>|auto      require a pairing token (22+ characters of A-Z a-z 0-9 _ -); `auto` makes one and prints it.",
      "                            Also read from AUDIORECTIVE_MCP_TOKEN (`auto` works there too). Default: no token.",
    ].join("\n"),
  );
  process.exit(0);
}
const origins = readValues(argv, "--allow-origin");
const rawToken = readValues(argv, "--token")[0] || process.env.AUDIORECTIVE_MCP_TOKEN || undefined;
const givenToken = rawToken === "auto" ? createToken() : rawToken;
const bridge = await PageBridge.listen({
  port: readPort(argv),
  waitMs: readWaitMs(argv),
  ...(origins.length ? { allowedOrigins: origins } : {}),
  allowMissingOrigin: argv.includes("--allow-missing-origin"),
  token: givenToken,
}).catch((error: Error) => {
  console.error(`audiorective-mcp: cannot start (${error.message}). Pick another port with --port, or fix the option named above.`);
  process.exit(1);
});
console.error(`audiorective-mcp: waiting for a page at ws://127.0.0.1:${bridge.port}`);
if (bridge.token !== undefined)
  console.error(
    rawToken === "auto"
      ? `audiorective-mcp: pairing token: ${bridge.token}\naudiorective-mcp: pass it as connectMcpBridge(tools, url, { token }).`
      : "audiorective-mcp: a pairing token is required; pass it as connectMcpBridge(tools, url, { token }).",
  );
await createMcpServer(bridge).connect(new StdioServerTransport());
