#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PageBridge, createMcpServer } from "./index";

function readWaitMs(argv: string[]): number {
  const at = argv.findIndex((arg) => arg === "--wait-ms" || arg.startsWith("--wait-ms="));
  if (at < 0) return 10_000;
  const raw = argv[at].includes("=") ? argv[at].split("=")[1] : argv[at + 1];
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms < 0) {
    console.error(`audiorective-mcp: --wait-ms needs a number of milliseconds, got "${raw}".`);
    process.exit(2);
  }
  return ms;
}

function readPort(argv: string[]): number {
  const at = argv.findIndex((arg) => arg === "--port" || arg.startsWith("--port="));
  if (at < 0) return 7777;
  const raw = argv[at].includes("=") ? argv[at].split("=")[1] : argv[at + 1];
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
    "Usage: audiorective-mcp [--port 7777] [--wait-ms 10000]\nMCP stdio server; the audiorective page connects to ws://127.0.0.1:<port>.",
  );
  process.exit(0);
}
const bridge = await PageBridge.listen({ port: readPort(argv), waitMs: readWaitMs(argv) }).catch((error: Error) => {
  console.error(`audiorective-mcp: cannot listen on the port (${error.message}). Pick another with --port.`);
  process.exit(1);
});
console.error(`audiorective-mcp: waiting for a page at ws://127.0.0.1:${bridge.port}`);
await createMcpServer(bridge).connect(new StdioServerTransport());
