import { Param, cell, readonlyCell } from "@audiorective/core";
import { afterEach, expect, test, vi } from "vitest";
import { mountMixer, mountParameter, type MixerState } from "../src";
import { cleanup, host, own } from "./helpers";

afterEach(cleanup);

const track = (id: string, volume = 1) => ({ id, name: id, volume, pan: 0, muted: false, solo: false });

function mounted(extra: Partial<Parameters<typeof mountMixer>[1]> = {}) {
  const source = cell<MixerState>({ tracks: [track("a")], masterVolume: 1 });
  const root = host();
  const mixer = mountMixer(root, {
    state: readonlyCell(source),
    editTrack: () => {},
    editMaster: () => {},
    ...extra,
  });
  own(() => mixer.dispose());
  return { source, root, mixer };
}

test("a reactive widget mounted by appendControls survives later mixer state changes", () => {
  const param = new Param({ default: 0, min: 0, max: 10 });
  own(() => param.dispose());
  const { source, root } = mounted({
    appendControls(_id, strip) {
      const view = mountParameter(strip, { param });
      return () => view.dispose();
    },
  });
  const input = () => root.querySelector<HTMLInputElement>(".mixer-strip:not(.master) .ar-parameter input")!;
  param.value = 3;
  expect(input().valueAsNumber).toBe(3);
  source.value = { tracks: [track("a", 0.5)], masterVolume: 1 };
  source.value = { tracks: [track("a", 0.4), track("b")], masterVolume: 1 };
  param.value = 7;
  expect(input().valueAsNumber).toBe(7);
});

test("meters are caller-owned readers, read through the level meter and released with the strip", () => {
  const disposed: Array<string | null> = [];
  const read = vi.fn();
  const { source, root } = mounted({
    meter: (id) => ({ sampleCount: 8, read, dispose: () => disposed.push(id) }),
  });
  expect(root.querySelectorAll(".ar-level-meter")).toHaveLength(2);
  expect(read).toHaveBeenCalled();
  source.value = { tracks: [], masterVolume: 1 };
  expect(disposed).toEqual(["a"]);
  expect(root.querySelectorAll(".ar-level-meter")).toHaveLength(1);
});
