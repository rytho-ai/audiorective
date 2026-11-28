import { afterEach, expect, test } from "vitest";
import { openWorkspace } from "../src";
import type { AudioClip, Workspace } from "../src";

/**
 * Two Workspaces opening the same Blob at once, at different sample rates: each decodes the compressed audio for its own context, and neither may see
 * the other's decoded audio while the file is read.
 */
const worklet = "/@fs" + new URL("../../host/dist/webclap-worklet.js", import.meta.url).pathname.replace(/^\/@fs/, "");
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("the same Blob opened by contexts at 44.1 and 48 kHz at once gives each Workspace audio at its own rate", async () => {
  const bytes = new Uint8Array(
    await (await fetch(new URL("./fixtures/compressed-audio/compressed-audio.dawproject", import.meta.url).href)).arrayBuffer(),
  );
  const blob = new Blob([bytes]);
  const rates = [44_100, 48_000, 44_100, 48_000];
  const contexts = rates.map((sampleRate) => {
    const context = new AudioContext({ sampleRate });
    cleanups.push(() => context.close());
    return context;
  });
  const workspaces: Workspace[] = await Promise.all(contexts.map((context) => openWorkspace(context, blob, { workletUrl: worklet })));
  for (const workspace of workspaces) cleanups.push(() => workspace.dispose());
  workspaces.forEach((workspace, i) => {
    for (const track of workspace.project.tracks) {
      const clip = track.clips[0] as AudioClip | undefined;
      if (!clip || clip.media) continue;
      expect(clip.sampleRate, `${track.name} of workspace ${i}`).toBe(rates[i]);
    }
    expect(workspace.project.tracks.some((track) => (track.clips[0] as AudioClip | undefined)?.media === undefined)).toBe(true);
  });
});
