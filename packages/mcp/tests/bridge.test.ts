import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { PageBridge, createMcpServer } from "../src/index";

const ORIGIN = "http://localhost:5173";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(waitMs = 0) {
  const bridge = await PageBridge.listen({ port: 0, timeoutMs: 500, waitMs });
  cleanups.push(() => bridge.close());
  const server = createMcpServer(bridge);
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  cleanups.push(() => client.close());
  return { bridge, client };
}

/** A fake page: serves `echo`, `boom` and a tool that never answers. */
async function connectPage(port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, ["audiorective.v1"], { origin: ORIGIN });
  const opened = new Promise((resolve) => socket.once("open", resolve));
  cleanups.push(() => socket.close());
  const calls: unknown[] = [];
  socket.on("message", (data) => {
    const frame = JSON.parse(String(data));
    if (frame.method === "list")
      socket.send(JSON.stringify({ id: frame.id, result: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }] }));
    else if (frame.name === "echo") {
      calls.push(frame.args);
      socket.send(JSON.stringify({ id: frame.id, result: { content: `echo ${JSON.stringify(frame.args)}` } }));
    } else if (frame.name === "bad") socket.send(JSON.stringify({ id: frame.id, result: { content: "nope", isError: true } }));
    else if (frame.name === "boom") socket.send(JSON.stringify({ id: frame.id, error: "page exploded" }));
  });
  await opened;
  return { socket, calls };
}

describe("MCP bridge", () => {
  test("lists and calls the tools the page serves", async () => {
    const { bridge, client } = await setup();
    const { calls } = await connectPage(bridge.port);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["echo"]);
    const result = await client.callTool({ name: "echo", arguments: { a: 1 } });
    expect(result.content).toEqual([{ type: "text", text: 'echo {"a":1}' }]);
    expect(result.isError).toBe(false);
    expect(calls).toEqual([{ a: 1 }]);
  });

  test("carries tool errors and page failures as isError results", async () => {
    const { bridge, client } = await setup();
    await connectPage(bridge.port);
    expect(await client.callTool({ name: "bad", arguments: {} })).toMatchObject({ isError: true, content: [{ text: "nope" }] });
    expect(await client.callTool({ name: "boom", arguments: {} })).toMatchObject({ isError: true, content: [{ text: "page exploded" }] });
    expect(await client.callTool({ name: "silent", arguments: {} })).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining("did not answer") }],
    });
  });

  test("says so when no page is connected", async () => {
    const { client } = await setup();
    expect((await client.listTools()).tools).toEqual([]);
    const result = await client.callTool({ name: "echo", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("No audiorective page is connected");
  });

  test("tools/list waits for a page that connects shortly after", async () => {
    const { bridge, client } = await setup(2000);
    const listing = client.listTools();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await connectPage(bridge.port);
    expect((await listing).tools.map((tool) => tool.name)).toEqual(["echo"]);
  });

  test("tools/list answers empty after the wait when no page connects", async () => {
    const { client } = await setup(150);
    const started = Date.now();
    expect((await client.listTools()).tools).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });

  test("declares listChanged and notifies when a page connects or leaves", async () => {
    const { bridge, client } = await setup();
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);
    expect(client.getInstructions()).toContain("no page is connected");
    let notified = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      notified++;
    });
    const { socket } = await connectPage(bridge.port);
    await vi.waitFor(() => expect(notified).toBe(1));
    socket.close();
    await vi.waitFor(() => expect(notified).toBe(2));
  });

  test("a page that leaves mid-call fails the call; a new page takes over", async () => {
    const { bridge, client } = await setup();
    const first = await connectPage(bridge.port);
    first.socket.removeAllListeners("message");
    const pending = client.callTool({ name: "echo", arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 50));
    first.socket.close();
    expect(await pending).toMatchObject({ isError: true });
    await connectPage(bridge.port);
    expect(await client.callTool({ name: "echo", arguments: { b: 2 } })).toMatchObject({ isError: false });
  });

  test("a newer page replaces the old one, which is closed with code 4000 and stays closed", async () => {
    const { bridge, client } = await setup();
    const first = await connectPage(bridge.port);
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      first.socket.once("close", (code, reason) => resolve({ code, reason: String(reason) })),
    );
    const second = await connectPage(bridge.port);
    expect(await closed).toEqual({ code: 4000, reason: "replaced by another page" });
    await client.callTool({ name: "echo", arguments: { n: 1 } });
    expect(second.calls).toEqual([{ n: 1 }]);
    expect(first.calls).toEqual([]);
    expect(bridge.connected).toBe(true);
  });

  test("a page error frame that is not a string still fails the call", async () => {
    const { bridge, client } = await setup();
    const { socket } = await connectPage(bridge.port);
    socket.removeAllListeners("message");
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data));
      if (frame.method === "call") socket.send(JSON.stringify({ id: frame.id, error: { message: "structured failure" } }));
    });
    const result = await client.callTool({ name: "echo", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("structured failure");
  });

  test("tools/list reports a page failure as an error, not an empty list", async () => {
    const { bridge, client } = await setup();
    const { socket } = await connectPage(bridge.port);
    socket.removeAllListeners("message");
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data));
      socket.send(JSON.stringify({ id: frame.id, error: "page exploded while listing" }));
    });
    await expect(client.listTools()).rejects.toThrow(/page exploded while listing/);
  });
});
