import { afterEach, describe, expect, test, vi } from "vitest";
import { cell, readonlyCell, type Cell } from "@audiorective/core";
import { mountClipGrid, type ClipGridClip, type ClipGridLauncher, type ClipGridTrack } from "../src";
import { cleanup, host } from "./helpers";

afterEach(async () => {
  await cleanup();
});

/** Stand-ins for a launcher's cells: the grid reads cells and calls commands, nothing else. */
function fake() {
  const clip = (): ClipGridClip & { _playing: Cell<boolean>; _queued: Cell<boolean>; launch: ReturnType<typeof vi.fn> } => {
    const _playing = cell(false);
    const _queued = cell(false);
    return { _playing, _queued, playing: readonlyCell(_playing), queued: readonlyCell(_queued), launch: vi.fn() };
  };
  const track = (): ClipGridTrack & { _playing: Cell<boolean>; stop: ReturnType<typeof vi.fn> } => {
    const _playing = cell(false);
    return { _playing, playing: readonlyCell(_playing), queued: readonlyCell(cell(null)), stop: vi.fn() };
  };
  const queued = cell<readonly { beat: number | null }[]>([]);
  const playing = cell<readonly unknown[]>([]);
  const launcher: ClipGridLauncher & {
    launchScene: ReturnType<typeof vi.fn>;
    stopAll: ReturnType<typeof vi.fn>;
    cancelQueued: ReturnType<typeof vi.fn>;
  } = { playing, queued, launchScene: vi.fn(), stopAll: vi.fn(), cancelQueued: vi.fn(() => true) };
  return { clip, track, queued, playing, launcher };
}

describe("mountClipGrid", () => {
  test("a scene row with an index launches the launcher's scene, so its empty-slot rule applies", () => {
    const { clip, track, launcher } = fake();
    const drums = track();
    const bass = track();
    const [d1, d2] = [clip(), clip()];
    const grid = mountClipGrid(host(), { launcher });
    grid.setLayout({
      tracks: [
        { track: drums, label: "Drums" },
        { track: bass, label: "Bass" },
      ],
      scenes: [
        { label: "Intro", index: 0, clips: [{ track: drums, clip: d1, label: "beat" }] },
        { label: "Drop", clips: [{ track: drums, clip: d2, label: "beat" }] },
      ],
    });
    const scene = (name: string) => [...document.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === name)!;
    scene("Scene Intro").click();
    expect(launcher.launchScene).toHaveBeenLastCalledWith(0);
    scene("Scene Drop").click();
    expect(launcher.launchScene).toHaveBeenLastCalledWith([d2]);
  });

  test("buttons call the launcher's commands and cells drive the markers", () => {
    const { clip, track, queued, playing, launcher } = fake();
    const drums = track();
    const bass = track();
    const [d1, b1] = [clip(), clip()];
    const grid = mountClipGrid(host(), { launcher });
    grid.setLayout({
      tracks: [
        { track: drums, label: "Drums" },
        { track: bass, label: "Bass" },
      ],
      scenes: [
        {
          label: "Intro",
          clips: [
            { track: drums, clip: d1, label: "beat" },
            { track: bass, clip: b1, label: "line" },
          ],
        },
      ],
    });
    const button = (name: string) =>
      [...document.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === name || item.textContent === name)!;
    button("Drums · Intro · beat").click();
    expect(d1.launch).toHaveBeenCalledTimes(1);
    button("Scene Intro").click();
    expect(launcher.launchScene).toHaveBeenCalledWith([d1, b1]);
    bass._playing.value = true;
    button("Bass · Back to Arrangement").click();
    expect(bass.stop).toHaveBeenCalledTimes(1);
    expect((button("Back to Arrangement") as HTMLButtonElement).disabled).toBe(true);
    playing.value = [d1];
    button("Back to Arrangement").click();
    expect(launcher.stopAll).toHaveBeenCalledTimes(1);

    const cellButton = button("Drums · Intro · beat");
    expect(cellButton.dataset.clipState).toBe("idle");
    d1._queued.value = true;
    queued.value = [{ beat: 3 }];
    expect(cellButton.dataset.clipState).toBe("queued");
    expect(document.querySelector("[role=status]")!.textContent).toBe("Queued for beat 4");
    button("Cancel queued launch").click();
    expect(launcher.cancelQueued).toHaveBeenCalled();
    d1._queued.value = false;
    d1._playing.value = true;
    drums._playing.value = true;
    queued.value = [];
    expect(cellButton.dataset.clipState).toBe("active");
    expect(cellButton.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector("[role=status]")!.textContent).toBe("Session playback");
    grid.dispose();
  });

  test("the launch option wraps every command, so an app can start playback first", () => {
    const { clip, track, launcher } = fake();
    const drums = track();
    const only = clip();
    const wrapped: Array<() => void> = [];
    const grid = mountClipGrid(host(), { launcher, launch: (command) => wrapped.push(command) });
    grid.setLayout({ tracks: [{ track: drums, label: "Drums" }], scenes: [{ label: "A", clips: [{ track: drums, clip: only, label: "x" }] }] });
    [...document.querySelectorAll("button")].find((item) => item.textContent === "x")!.click();
    expect(only.launch).not.toHaveBeenCalled();
    wrapped[0]!();
    expect(only.launch).toHaveBeenCalledTimes(1);
    grid.dispose();
  });

  test("an empty layout shows the empty label and hides the toolbar", () => {
    const { launcher } = fake();
    const root = host();
    const grid = mountClipGrid(root, { launcher, labels: { empty: "Nothing to launch" } });
    grid.setLayout({ tracks: [], scenes: [] });
    expect(root.textContent).toContain("Nothing to launch");
    grid.dispose();
  });
});
