import { afterEach, describe, expect, test } from "vitest";
import { Project, Workspace, defineOperation, renderMixRange, selectionFor, sessionFor } from "../src";
import { mcpTools, connectMcpBridge, type McpBridgeSocket, type McpTool, type McpToolResult } from "../src/mcp";

const RATE = 48_000;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const pattern = (frames: number, seed: number) =>
  Float32Array.from({ length: frames }, (_, i) => (((i * 7919 + seed * 104729) % 2003) / 2003 - 0.5) * 0.4);

async function song(save?: (bytes: Uint8Array, name: string) => void) {
  const project = new Project({ bpm: 120 });
  project.setTitle("Agent song");
  project.setMarkers([
    { time: 0, name: "Verse" },
    { time: 4, name: "Chorus" },
  ]);
  const drums = project.addTrack("Drums", "audio");
  const vocals = project.addTrack("Vocals", "audio");
  // 120 bpm: one beat is 0.5 s. The chorus is beats 8-16 (4-8 s).
  const drumClip = project.addAudioClip(drums.id, { sampleRate: RATE, channels: [pattern(4 * RATE, 1)] }, 4);
  project.addAudioClip(vocals.id, { sampleRate: RATE, channels: [pattern(2 * RATE, 2)] }, 4);
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
  const context = new AudioContext({ sampleRate: RATE });
  const workspace = await Workspace.create(context, project);
  cleanups.push(async () => {
    workspace.dispose();
    project.dispose();
    await context.close();
  });
  selectionFor(project).selectClips([drumClip.id]);
  selectionFor(project).selectRange({ startBeat: 8, endBeat: 16 });
  const tools = mcpTools(workspace, { save });
  const tool = (name: string): McpTool => tools.find((candidate) => candidate.name === name)!;
  const call = (name: string, args: unknown): Promise<McpToolResult> => tool(name).call(args);
  return { project, workspace, tools, call, drums, vocals, drumClip };
}

const parse = (result: McpToolResult) => JSON.parse(result.content);

describe("mcpTools", () => {
  test("lists the six tools with object schemas", async () => {
    const { tools } = await song();
    expect(tools.map((tool) => tool.name)).toEqual(["read_project", "find", "apply_edits", "run_operation", "listen", "save_as"]);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });

  test("read_project returns TOON with the selection, version, playback and operations", async () => {
    const { call, project, drumClip } = await song();
    const result = await call("read_project", {});
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain(`version: "${project.cells.version.value}"`);
    expect(result.content).toContain("title: Agent song");
    expect(result.content).toContain(drumClip.id);
    expect(result.content).toContain("selection:");
    expect(result.content).toContain("startBeat: 8");
    expect(result.content).toContain("playing: false");
    expect(result.content).toContain("add-marker");
    expect(result.content).toContain("Chorus");
    expect((await call("read_project", "nope")).isError).toBe(true);
  });

  test("find locates clips and markers and reports bad input as an error result", async () => {
    const { call, vocals } = await song();
    const clips = await call("find", { type: "clips", trackName: "Vocals" });
    expect(clips.content).toContain("count: 1");
    expect(clips.content).toContain(vocals.id);
    expect((await call("find", { type: "clips", range: { startBeat: 100, endBeat: 120 } })).content).toContain("count: 0");
    expect((await call("find", { type: "marker", name: "Chorus" })).content).toContain("seconds: 4");
    expect((await call("find", { type: "marker", name: "Bridge" })).isError).toBe(true);
    expect((await call("find", { type: "clips", range: { startBeat: 5, endBeat: 1 } })).isError).toBe(true);
    expect((await call("find", {})).isError).toBe(true);
  });

  test("apply_edits is one Agent undo step, reports playback and refuses a stale version", async () => {
    const { call, project, workspace } = await song();
    const before = project.cells.version.value;
    const result = await call("apply_edits", {
      expectedVersion: before,
      label: "Repeat chorus",
      ops: [
        { type: "copyRange", range: { startBeat: 8, endBeat: 16 }, atBeat: 16, placement: "insert", as: "chorus" },
        { type: "moveClip", clip: { fromCopy: "chorus", trackName: "Vocals" }, position: { byBeats: 1 } },
      ],
    });
    expect(result.isError).toBeUndefined();
    const receipt = parse(result);
    expect(receipt.status).toBe("applied");
    expect(receipt.version).toBe(project.cells.version.value);
    expect(receipt.version).not.toBe(before);
    expect(receipt.playback).toMatchObject({ status: "applied", inPlayback: true, needsSync: false, error: null });
    expect(receipt.created.length).toBeGreaterThan(0);
    expect(project.cells.history.value.undo).toBe("Agent: Repeat chorus");
    expect(workspace.cells.error.value).toBeNull();

    // One undo removes the whole agent edit.
    expect(project.undo().status).toBe("applied");
    expect(project.cells.version.value).not.toBe(receipt.version);
    expect(project.findClips({ trackName: "Drums" })).toHaveLength(1);
    expect(project.cells.history.value.undo).toBeUndefined();
  });

  test("a human edit between read and apply is a conflict that leaves the human edit intact", async () => {
    const { call, project, drums } = await song();
    const read = project.cells.version.value;
    project.setTempoChanges([{ beat: 4, bpm: 90 }]);
    const human = project.cells.version.value;
    const result = await call("apply_edits", {
      expectedVersion: read,
      label: "Late edit",
      ops: [{ type: "copyRange", range: { startBeat: 8, endBeat: 16 }, atBeat: 16, placement: "insert", as: "c" }],
    });
    expect(result.isError).toBe(true);
    const body = parse(result);
    expect(body).toMatchObject({ status: "conflict", currentVersion: human });
    expect(project.cells.version.value).toBe(human);
    expect(project.overview().tempoChanges).toEqual([{ beat: 4, bpm: 90 }]);
    expect(project.findClips({ trackId: drums.id })).toHaveLength(1);
    // Re-reading and retrying with the new version works.
    const retry = await call("apply_edits", {
      expectedVersion: human,
      label: "Late edit",
      ops: [{ type: "copyRange", range: { startBeat: 8, endBeat: 16 }, atBeat: 16, placement: "insert", as: "c" }],
    });
    expect(parse(retry).status).toBe("applied");
  });

  test("apply_edits rejects bad requests without changing the project", async () => {
    const { call, project } = await song();
    const version = project.cells.version.value;
    expect((await call("apply_edits", { label: "x", ops: [{ type: "renameClip" }] })).content).toContain("expectedVersion");
    expect((await call("apply_edits", { expectedVersion: version, label: " ", ops: [{ type: "x" }] })).isError).toBe(true);
    expect((await call("apply_edits", { expectedVersion: version, label: "x", ops: [] })).isError).toBe(true);
    const rejected = await call("apply_edits", {
      expectedVersion: version,
      label: "Missing clip",
      ops: [{ type: "renameClip", clip: { clipId: "nope" }, name: "x" }],
    });
    expect(rejected.isError).toBe(true);
    expect(parse(rejected)).toMatchObject({ status: "rejected", code: "clip-not-found", opIndex: 0 });
    expect(project.cells.version.value).toBe(version);
  });

  test("apply_edits says when a structural change waits for sync", async () => {
    const { call, project } = await song();
    project.addTrack("Bass", "midi");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const result = await call("apply_edits", {
      expectedVersion: project.cells.version.value,
      label: "Rename",
      ops: [{ type: "renameClip", clip: { clipId: project.findClips({ trackName: "Drums" })[0].id }, name: "Kick" }],
    });
    const receipt = parse(result);
    expect(receipt.status).toBe("applied");
    expect(receipt.playback.needsSync).toBe(true);
    expect(receipt.playback.inPlayback).toBe(false);
  });

  test("run_operation runs a named operation as one step and reports errors", async () => {
    const { call, project } = await song();
    const done = await call("run_operation", { name: "add-marker", args: { name: "Bridge" } });
    expect(parse(done)).toMatchObject({ status: "applied", result: { name: "Bridge" }, playback: { inPlayback: true } });
    expect(project.markers.map((marker) => marker.name)).toContain("Bridge");
    expect(project.cells.history.value.undo).toBe("Add a marker");
    const unknown = await call("run_operation", { name: "nope" });
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toContain("add-marker");
    expect((await call("run_operation", { name: "add-marker", args: {} })).content).toContain("name");
    const stale = await call("run_operation", { name: "add-marker", args: { name: "X" }, expectedVersion: "old" });
    expect(parse(stale).status).toBe("conflict");
    expect(project.markers.map((marker) => marker.name)).not.toContain("X");
    expect((await call("run_operation", {})).isError).toBe(true);
  });

  test("listen returns the numbers renderMixRange measures and never raw audio", async () => {
    const { call, project, workspace } = await song();
    const range = { startBeat: 8, endBeat: 16 };
    const result = await call("listen", { range, seamBeats: [10] });
    const body = parse(result);
    const direct = await renderMixRange(workspace, { expectedVersion: project.cells.version.value, range, seamBeats: [10] });
    if (direct.status !== "rendered") throw new Error("expected a render");
    expect(body.status).toBe("rendered");
    expect(body.peakDbFS).toBeCloseTo(direct.peakDbFS!, 1);
    expect(body.loudnessLUFS).toBeCloseTo(direct.loudnessLUFS!, 1);
    expect(body.durationSeconds).toBeCloseTo(direct.durationSeconds, 2);
    expect(body.seams).toHaveLength(1);
    expect(body.seams[0].hasClick).toBe(direct.seams[0].hasClick);
    expect(result.content).not.toContain("channels");
    expect(body.silentSpans).toEqual([]);

    // The song is silent before beat 8 (second 4): the whole range reads as one silent span.
    const quiet = parse(await call("listen", { range: { startSeconds: 0, endSeconds: 3 } }));
    expect(quiet.peakDbFS).toBeNull();
    expect(quiet.silentSpans).toEqual([{ startSeconds: 0, endSeconds: 3 }]);

    const stale = await call("listen", { range, expectedVersion: "old" });
    expect(stale.isError).toBe(true);
    expect(parse(stale).status).toBe("conflict");
    expect((await call("listen", { range: { startBeat: 4, endBeat: 2 } })).isError).toBe(true);
    expect((await call("listen", {})).isError).toBe(true);
    expect((await call("listen", { range, seamBeats: "x" })).isError).toBe(true);
  }, 60_000);

  test("save_as hands the file bytes to the app's saver", async () => {
    const saved: Array<{ name: string; bytes: Uint8Array }> = [];
    const { call, project } = await song((bytes, name) => void saved.push({ name, bytes }));
    const result = await call("save_as", { name: "agent.dawproject" });
    expect(parse(result)).toMatchObject({ status: "saved", name: "agent.dawproject", version: project.cells.version.value });
    expect(saved).toHaveLength(1);
    expect(saved[0].bytes[0]).toBe(0x50); // a zip archive
    expect(parse(result).bytes).toBe(saved[0].bytes.length);
    expect((await call("save_as", { name: "x", expectedVersion: "old" })).isError).toBe(true);
    expect((await call("save_as", {})).isError).toBe(true);
    expect(saved).toHaveLength(1);
  });

  test("save_as without a saver is an error result", async () => {
    const { call } = await song();
    const result = await call("save_as", { name: "x.dawproject" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("save handler");
  });
});

describe("mcpTools clip windows", () => {
  async function windowed() {
    const base = await song();
    const keys = base.project.addTrack("Keys", "midi");
    const midi = base.project.addMidiClip(keys.id, { duration: 16, notes: [{ id: "n1", pitch: 60, velocity: 0.5, start: 0, duration: 1 }] }, 0);
    base.project.resizeClip(midi.id, { start: 4, end: 12 });
    base.project.setClipLoop(midi.id, { startBeat: 4, endBeat: 8 });
    const slot = sessionFor(base.project);
    const scene = slot.addScene();
    const slotClip = slot.setMidiClip({ sceneId: scene.id, trackId: keys.id }, { duration: 8, notes: [] });
    base.project.resizeClip(slotClip.id, { start: 2 });
    return { ...base, midi, slotClip };
  }

  test("read_project and find show the window and loop of MIDI clips and the window of audio clips, timeline and slot", async () => {
    const { call, midi, slotClip, drumClip } = await windowed();
    const text = (await call("read_project", {})).content;
    expect(text).toContain("sourceOffset");
    expect(text).toContain("loop");
    const found = (await call("find", { type: "clips", trackName: "Keys" })).data as { clips: Record<string, unknown>[] };
    expect(found.clips[0]).toMatchObject({ id: midi.id, sourceOffset: 4, loopStart: 4, loopEnd: 8 });
    const view = (await call("read_project", {})).data as { clips: Record<string, unknown>[]; slotClips: Record<string, unknown>[] };
    expect(view.clips.find((clip) => clip.id === midi.id)).toMatchObject({ sourceOffset: 4, loopStart: 4, loopEnd: 8 });
    expect(view.slotClips.find((clip) => clip.id === slotClip.id)).toMatchObject({ sourceOffset: 2 });
    expect(view.clips.find((clip) => clip.id === drumClip.id)).toMatchObject({ sourceOffset: 0, sourceLength: 4 });
  });

  test("apply_edits lists and runs resizeClip and setClipSourceRange", async () => {
    const { call, tools, project, midi } = await windowed();
    const description = tools.find((tool) => tool.name === "apply_edits")!.description;
    expect(description).toContain("resizeClip");
    expect(description).toContain("setClipSourceRange");
    const schema = JSON.stringify(tools.find((tool) => tool.name === "apply_edits")!.inputSchema);
    expect(schema).toContain("resizeClip");
    expect(schema).toContain("setClipSourceRange");
    project.setClipLoop(midi.id, null); // setClipSourceRange needs a clip without a loop
    const result = await call("apply_edits", {
      expectedVersion: project.cells.version.value,
      label: "Window",
      ops: [
        { type: "resizeClip", clip: { clipId: midi.id }, start: 2, end: 14 },
        { type: "setClipSourceRange", clip: { clipId: midi.id }, start: 1, end: 5 },
      ],
    });
    expect(parse(result).status).toBe("applied");
    const clip = project.findClips({ trackName: "Keys" })[0];
    expect([clip.startBeat, clip.sourceOffset, clip.durationBeats]).toEqual([2, 1, 4]);
  });
});

describe("connectMcpBridge", () => {
  class FakeSocket {
    static instances: FakeSocket[] = [];
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: ((event: unknown) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    sent: any[] = [];
    closed = false;
    constructor(readonly url: string) {
      FakeSocket.instances.push(this);
    }
    send(data: string) {
      this.sent.push(JSON.parse(data));
    }
    close() {
      this.closed = true;
    }
  }
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(check()).toBe(true);
  };

  test("answers list and call frames, reports unknown tools and reconnects with backoff", async () => {
    FakeSocket.instances = [];
    const { tools } = await song();
    const states: boolean[] = [];
    const bridge = connectMcpBridge(tools, "ws://test", {
      WebSocket: FakeSocket,
      reconnectMs: 10,
      maxReconnectMs: 20,
      onStatus: (c) => states.push(c),
    });
    cleanups.push(() => bridge.close());
    const first = FakeSocket.instances[0];
    first.onopen?.({});
    first.onmessage?.({ data: JSON.stringify({ id: 1, method: "list" }) });
    await until(() => first.sent.length === 1);
    expect(first.sent[0].result.map((tool: McpTool) => tool.name)).toContain("apply_edits");
    expect(first.sent[0].result[0].call).toBeUndefined();
    first.onmessage?.({ data: JSON.stringify({ id: 2, method: "call", name: "read_project", args: {} }) });
    first.onmessage?.({ data: JSON.stringify({ id: 3, method: "call", name: "nope" }) });
    first.onmessage?.({ data: JSON.stringify({ id: 4, method: "wat" }) });
    first.onmessage?.({ data: "not json" });
    await until(() => [2, 3, 4].every((id) => first.sent.some((frame) => frame.id === id)));
    expect(first.sent.find((frame) => frame.id === 2).result.content).toContain("title: Agent song");
    expect(first.sent.find((frame) => frame.id === 3).error).toContain("nope");
    expect(first.sent.find((frame) => frame.id === 4).error).toContain("wat");
    first.onclose?.({});
    await until(() => FakeSocket.instances.length === 2);
    FakeSocket.instances[1].onopen?.({});
    expect(states).toEqual([true, false, true]);
    bridge.close();
    FakeSocket.instances[1].onclose?.({});
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(FakeSocket.instances).toHaveLength(2);
  });

  test("does not reconnect after the server replaced this page, until connect() is called", async () => {
    FakeSocket.instances = [];
    const { tools } = await song();
    const replaced: unknown[] = [];
    const bridge = connectMcpBridge(tools, "ws://test", { WebSocket: FakeSocket, reconnectMs: 10, onReplaced: () => replaced.push(1) });
    cleanups.push(() => bridge.close());
    FakeSocket.instances[0].onopen?.({});
    FakeSocket.instances[0].onclose?.({ code: 4000, reason: "replaced by another page" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(FakeSocket.instances).toHaveLength(1);
    expect(replaced).toHaveLength(1);
    bridge.connect();
    expect(FakeSocket.instances).toHaveLength(2);
    FakeSocket.instances[1].onclose?.({ code: 1006 });
    await until(() => FakeSocket.instances.length === 3);
  });

  test("a throwing WebSocket constructor is retried and reported", async () => {
    let attempts = 0;
    class Throwing {
      constructor() {
        attempts++;
        throw new SyntaxError("bad url");
      }
    }
    const { tools } = await song();
    const states: boolean[] = [];
    const bridge = connectMcpBridge(tools, "nope", {
      WebSocket: Throwing as unknown as new (url: string) => McpBridgeSocket,
      reconnectMs: 10,
      maxReconnectMs: 20,
      onStatus: (c) => states.push(c),
    });
    cleanups.push(() => bridge.close());
    await until(() => attempts >= 3);
    expect(states.length).toBeGreaterThanOrEqual(1);
    expect(states.every((c) => c === false)).toBe(true);
  });
});
