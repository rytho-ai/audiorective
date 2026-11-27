import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import { PageBridge, createMcpServer } from "../src/index";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("a result's audio part reaches the agent as an MCP audio block after the text", async () => {
  const bridge = await PageBridge.listen({ port: 0, timeoutMs: 500, waitMs: 0 });
  cleanups.push(() => bridge.close());
  const server = createMcpServer(bridge);
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  cleanups.push(() => client.close());
  const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}`, ["audiorective.v1"], { origin: "http://localhost:5173" });
  await new Promise((resolve) => socket.once("open", resolve));
  cleanups.push(() => socket.close());
  socket.on("message", (data) => {
    const frame = JSON.parse(String(data));
    const result = frame.name === "heard" ? { content: "{}", audio: { mimeType: "audio/wav", base64: "UklGRg==" } } : { content: "{}" };
    socket.send(JSON.stringify({ id: frame.id, result }));
  });
  expect((await client.callTool({ name: "heard", arguments: {} })).content).toEqual([
    { type: "text", text: "{}" },
    { type: "audio", data: "UklGRg==", mimeType: "audio/wav" },
  ]);
  expect((await client.callTool({ name: "quiet", arguments: {} })).content).toEqual([{ type: "text", text: "{}" }]);
});
