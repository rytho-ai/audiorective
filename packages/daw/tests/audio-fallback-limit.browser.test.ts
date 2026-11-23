import { expect, test, vi } from "vitest";
import { Project, Workspace } from "../src";
import { exportAudioFallbackTo } from "../src/audio-fallback";

test("a render the browser refuses to allocate fails with the export's own error and aborts the destination", async () => {
  const project = new Project({ title: "Too long", bpm: 120 });
  const track = project.addTrack("A", "audio");
  project.addAudioClip(track.id, { sampleRate: 48_000, channels: [new Float32Array(480).fill(0.1)] }, 0);
  const context = new AudioContext({ sampleRate: 48_000 });
  const workspace = await Workspace.create(context, project);
  const refused = new DOMException("startRendering failed to create audio buffer", "NotSupportedError");
  const start = vi.spyOn(OfflineAudioContext.prototype, "startRendering").mockRejectedValue(refused);
  let aborted: unknown;
  try {
    const destination = new WritableStream<Uint8Array>({
      abort(reason) {
        aborted = reason;
      },
    });
    const failure = await exportAudioFallbackTo(workspace, destination, { tailSeconds: 0 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/^Workspace audio fallback could not start an offline render of [\d.]+ seconds: /);
    expect(aborted).toBe(failure);
  } finally {
    start.mockRestore();
    workspace.dispose();
    project.dispose();
    await context.close();
  }
});
