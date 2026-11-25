import { effect } from "@audiorective/core";
import { afterEach, describe, expect, test } from "vitest";
import { Project, Workspace, saveDawProject } from "../src";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Ctx = { project: Project; workspace: Workspace; trackId: string };

/** Each row reads a `workspace.cells` entry inside an effect, changes it through the owner's public API, and expects the effect to re-run with a new value. */
const rows: Record<string, { read: (c: Ctx) => unknown; mutate: (c: Ctx) => Promise<unknown> | void }> = {
  // `workspace.open(...)` swaps the song in place: readers of `project` and `loop` re-run without being rebound.
  open: {
    read: (c) => [c.workspace.project, c.workspace.loop.cells.enabled.value],
    mutate: async (c) => {
      const next = new Project({ bpm: 100 });
      next.addTrack("Next", "audio");
      const bytes = saveDawProject(next);
      next.dispose();
      await c.workspace.open(bytes);
    },
  },
  levels: {
    read: (c) => c.workspace.cells.levels.value,
    mutate: async (c) => {
      c.project.addAudioClip(
        c.trackId,
        { sampleRate: 48000, channels: [Float32Array.from({ length: 48000 * 3 }, (_, i) => 0.5 * Math.sin(i / 20))] },
        0,
      );
      await c.workspace.sync();
      await c.workspace.play();
      await new Promise((resolve) => setTimeout(resolve, 400));
    },
  },
};

// Cells whose tracking is exercised by their own suites; a new cell must get a row or an entry here with a reason.
const COVERED_ELSEWHERE: Record<string, string> = {
  needsSync: "project-edits.browser.test.ts",
  error: "runtime.test.ts",
  warnings: "runtime.test.ts",
  session: "session-*.browser.test.ts",
  auditioningClip: "audition tests",
  auditioningRange: "audition tests",
};

async function make(): Promise<Ctx> {
  const project = new Project({ bpm: 120 });
  const trackId = project.addTrack("Tone", "audio").id;
  const context = new AudioContext({ sampleRate: 48000 });
  const workspace = await Workspace.create(context, project, {});
  cleanups.push(async () => {
    workspace.dispose();
    project.dispose();
    await context.close();
  });
  return { project, workspace, trackId };
}

describe("Workspace cells are tracked", () => {
  test("every cell has a row or a reason", async () => {
    const { workspace } = await make();
    const missing = Object.keys(workspace.cells).filter((name) => !(name in rows) && !(name in COVERED_ELSEWHERE));
    expect(missing).toEqual([]);
  });

  test.each(Object.keys(rows))(
    "%s re-runs an effect when it changes",
    async (name) => {
      const ctx = await make();
      const row = rows[name]!;
      const seen: unknown[] = [];
      const stop = effect(() => void seen.push(row.read(ctx)));
      const first = seen[0];
      try {
        await row.mutate(ctx);
      } finally {
        stop();
      }
      expect(seen.length).toBeGreaterThan(1);
      expect(Object.is(seen[seen.length - 1], first)).toBe(false);
    },
    30_000,
  );
});
