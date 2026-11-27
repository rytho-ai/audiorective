import { decode } from "@toon-format/toon";
import { afterEach, describe, expect, test } from "vitest";
import { Project, Workspace, defineOperation } from "../src";
import { connectMcpBridge, mcpTools, type McpBridgeSocket, type McpTool, type McpToolCategory, type McpToolResult } from "../src/mcp";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(allow?: readonly McpToolCategory[]) {
  const project = new Project({ bpm: 120 });
  project.addTrack("Drums", "audio");
  project.operations.register(
    defineOperation({
      name: "add-marker",
      description: "Add a marker",
      input: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      run: (target, args: { name: string }) => {
        target.setMarkers([...target.markers, { time: 6, name: args.name }]);
        return { name: args.name };
      },
    }),
  );
  project.operations.register(
    defineOperation({
      name: "count-tracks",
      description: "Count tracks",
      input: { type: "object" },
      readOnly: true,
      run: (target) => target.tracks.length,
    }),
  );
  const context = new AudioContext({ sampleRate: 48_000 });
  const workspace = await Workspace.create(context, project);
  cleanups.push(async () => {
    workspace.dispose();
    project.dispose();
    await context.close();
  });
  const tools = mcpTools(workspace, { allow, save: () => {} });
  const call = (name: string, args: unknown = {}): Promise<McpToolResult> => tools.find((tool) => tool.name === name)!.call(args);
  return { project, tools, call, names: tools.map((tool) => tool.name) };
}

const EXPECTED: Record<string, McpToolCategory> = {
  read_project: "read",
  find: "read",
  read_notes: "read",
  read_automation: "read",
  read_device_params: "read",
  listen: "read",
  apply_edits: "edit",
  run_operation: "operations",
  save_as: "export",
  export_midi: "export",
  export_stems: "export",
};

describe("mcpTools permissions", () => {
  test("every tool declares a valid category, and the default lists them all", async () => {
    const { tools } = await setup();
    const valid = ["read", "edit", "export", "operations"];
    for (const tool of tools) expect(valid, `${tool.name} needs a category`).toContain(tool.category);
    expect(Object.fromEntries(tools.map((tool) => [tool.name, tool.category]))).toEqual(EXPECTED);
  });

  test("read lists the queries and run_operation, not the edit or export tools", async () => {
    const { names, call, project } = await setup(["read"]);
    expect(names).toEqual(["read_project", "find", "read_notes", "read_automation", "read_device_params", "run_operation", "listen"]);
    const version = project.cells.version.value;

    const refused = await call("run_operation", { name: "add-marker", args: { name: "X" } });
    expect(refused.isError).toBe(true);
    expect(refused.content).toBe(
      'This app does not let the agent run operation "add-marker" because it changes the project (permission "operations" is off). Tell the person.',
    );
    expect(project.cells.version.value).toBe(version);
    expect(project.markers).toEqual([]);

    const allowed = JSON.parse((await call("run_operation", { name: "count-tracks" })).content);
    expect(allowed).toMatchObject({ status: "read", result: 1 });

    const view = decode((await call("read_project")).content) as { operations: { name: string }[] };
    expect(view.operations.map((operation) => operation.name)).toEqual(["count-tracks"]);
  });

  test("operations alone runs changing operations and refuses read-only ones", async () => {
    const { names, call, project } = await setup(["operations"]);
    expect(names).toEqual(["run_operation"]);
    expect(JSON.parse((await call("run_operation", { name: "add-marker", args: { name: "Y" } })).content)).toMatchObject({ status: "applied" });
    expect(project.markers.map((marker) => marker.name)).toEqual(["Y"]);
    const refused = await call("run_operation", { name: "count-tracks" });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.content).toContain('permission "read" is off');
  });

  test("edit and export each list only their own tools; an empty allow lists none", async () => {
    expect((await setup(["edit"])).names).toEqual(["apply_edits"]);
    expect((await setup(["export"])).names).toEqual(["save_as", "export_midi", "export_stems"]);
    expect((await setup([])).names).toEqual([]);
  });

  test("an unknown category throws", async () => {
    const project = new Project({ bpm: 120 });
    const context = new AudioContext({ sampleRate: 48_000 });
    const workspace = await Workspace.create(context, project);
    cleanups.push(async () => {
      workspace.dispose();
      project.dispose();
      await context.close();
    });
    expect(() => mcpTools(workspace, { allow: ["read", "all" as never] })).toThrow(/unknown permission "all" in allow/);
  });
});

describe("connectMcpBridge token and unknown tools", () => {
  class RecordingSocket implements McpBridgeSocket {
    static opened: { url: string; protocols?: string[]; socket: RecordingSocket }[] = [];
    onopen: McpBridgeSocket["onopen"] = null;
    onmessage: McpBridgeSocket["onmessage"] = null;
    onclose: McpBridgeSocket["onclose"] = null;
    onerror: McpBridgeSocket["onerror"] = null;
    sent: string[] = [];
    constructor(url: string, protocols?: string[]) {
      RecordingSocket.opened.push({ url, protocols, socket: this });
    }
    send(data: string) {
      this.sent.push(data);
    }
    close() {}
  }

  test("offers the token as subprotocols, and none without one", () => {
    RecordingSocket.opened = [];
    const token = "abcdefghijklmnopqrstuvwxyz012345";
    const withToken = connectMcpBridge([], "ws://x", { WebSocket: RecordingSocket, token });
    const without = connectMcpBridge([], "ws://x", { WebSocket: RecordingSocket });
    cleanups.push(
      () => withToken.close(),
      () => without.close(),
    );
    expect(RecordingSocket.opened[0]).toMatchObject({ url: "ws://x", protocols: ["audiorective.v1", `audiorective.token.${token}`] });
    expect(RecordingSocket.opened[1].protocols).toBeUndefined();
    expect(() => connectMcpBridge([], "ws://x", { WebSocket: RecordingSocket, token: "short" })).toThrow(/token must be at least 22/);
  });

  test("a call for a tool the policy removed answers with a sentence that lists what is served", async () => {
    const { tools } = await setup(["read"]);
    RecordingSocket.opened = [];
    const bridge = connectMcpBridge(tools as readonly McpTool[], "ws://x", { WebSocket: RecordingSocket });
    cleanups.push(() => bridge.close());
    const { socket } = RecordingSocket.opened[0];
    socket.onmessage?.({ data: JSON.stringify({ id: 1, method: "call", name: "apply_edits", args: {} }) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const frame = JSON.parse(socket.sent[0]);
    expect(frame.id).toBe(1);
    expect(frame.error).toMatch(
      /^No tool named "apply_edits"\. This page serves: read_project, find, read_notes, read_automation, read_device_params, run_operation, listen\.$/,
    );
  });
});
