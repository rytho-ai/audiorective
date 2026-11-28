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
    meter: (id) => ({ source: { sampleCount: 8, read }, dispose: () => disposed.push(id) }),
  });
  expect(root.querySelectorAll(".ar-level-meter")).toHaveLength(2);
  expect(read).toHaveBeenCalled();
  source.value = { tracks: [], masterVolume: 1 };
  expect(disposed).toEqual(["a"]);
  expect(root.querySelectorAll(".ar-level-meter")).toHaveLength(1);
});

test("unsupported optional controls and master are absent without allocating a master meter", () => {
  const state = cell<MixerState>({ tracks: [{ id: "a", name: "A", volume: 0.5, pan: 0 }] });
  const requested: Array<string | null> = [];
  const root = host();
  const mixer = mountMixer(root, {
    state,
    editTrack: () => {},
    meter(id) {
      requested.push(id);
      return { source: () => -20 };
    },
  });
  own(() => mixer.dispose());
  expect(root.querySelector(".master")).toBeNull();
  expect(root.querySelector(".mute")).toBeNull();
  expect(root.querySelector(".solo")).toBeNull();
  expect(root.querySelectorAll('input[type="range"]')).toHaveLength(2);
  expect(requested).toEqual(["a"]);
  expect(root.querySelector(".ar-level-meter")?.textContent).toContain("-20.0 dBFS");
});

test.each([true, false])("keyed strips preserve focused custom controls on reorder (state-preserving moves: %s)", (nativeMove) => {
  const detach = vi.fn();
  const { source, root } = mounted({
    appendControls(id, strip) {
      const input = document.createElement("input");
      input.setAttribute("aria-label", `${id} custom`);
      strip.append(input);
      return detach;
    },
  });
  if (!nativeMove) Object.defineProperty(root.querySelector(".mixer")!, "moveBefore", { value: undefined });
  source.value = { tracks: [track("b"), track("a")], masterVolume: 1 };
  const input = root.querySelector<HTMLInputElement>('[aria-label="a custom"]')!;
  input.value = "borrowed control";
  input.focus();
  input.setSelectionRange(3, 7);
  source.value = { tracks: [track("a", 0.5), track("b")], masterVolume: 0.6 };
  expect(root.querySelector('[aria-label="a custom"]')).toBe(input);
  expect(document.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([3, 7]);
  expect(input.value).toBe("borrowed control");
  expect(detach).not.toHaveBeenCalled();
  expect(root.querySelector(".mixer")!.firstElementChild!.classList.contains("master")).toBe(true);
  expect([...root.querySelectorAll<HTMLElement>("[data-track-id]")].map((row) => row.dataset.trackId)).toEqual(["a", "b"]);
});

test.each([false, true])("fallback reorders preserve focused custom inputs across open shadow roots (nested: %s)", (nested) => {
  const shadow = host().attachShadow({ mode: "open" });
  const root = document.createElement("div");
  shadow.append(root);
  const state = cell<MixerState>({ tracks: [track("a"), track("b")] });
  const inputs = new Map<string, HTMLInputElement>();
  const detach = vi.fn();
  const mixer = mountMixer(root, {
    state,
    editTrack() {},
    appendControls(id, strip) {
      const input = document.createElement("input");
      if (nested) {
        const custom = document.createElement("div");
        strip.append(custom);
        custom.attachShadow({ mode: "open" }).append(input);
      } else strip.append(input);
      inputs.set(id, input);
      return detach;
    },
  });
  own(() => mixer.dispose());
  Object.defineProperty(root.querySelector(".mixer")!, "moveBefore", { value: undefined });
  const input = inputs.get("b")!;
  const inputRoot = input.getRootNode() as ShadowRoot;
  input.value = "borrowed draft";
  input.focus();
  input.setSelectionRange(2, 8, "backward");
  expect(inputRoot.activeElement).toBe(input);

  state.value = { tracks: [track("b", 0.6), track("a")] };

  expect(inputs.get("b")).toBe(input);
  expect(input.isConnected).toBe(true);
  expect(inputRoot.activeElement).toBe(input);
  expect(input.value).toBe("borrowed draft");
  expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([2, 8, "backward"]);
  expect(detach).not.toHaveBeenCalled();
  expect([...root.querySelectorAll<HTMLElement>("[data-track-id]")].map((row) => row.dataset.trackId)).toEqual(["b", "a"]);
});

test.each(["gain", "command"] as const)("master needs both a gain and an edit command, not just %s", (provided) => {
  const requested: Array<string | null> = [];
  const root = host();
  const state = cell<MixerState>({ tracks: [track("a")], masterVolume: provided === "gain" ? 1 : undefined });
  const mixer = mountMixer(root, {
    state,
    editTrack: () => {},
    editMaster: provided === "command" ? () => {} : undefined,
    meter(id) {
      requested.push(id);
      return { source: () => -Infinity };
    },
  });
  own(() => mixer.dispose());
  expect(root.querySelector(".master")).toBeNull();
  expect(requested).toEqual(["a"]);
});

test("optional controls follow owner capabilities in place and send edits only through commands", () => {
  const editTrack = vi.fn();
  const editMaster = vi.fn();
  const state = cell<MixerState>({ tracks: [{ id: "a", name: "A", volume: 0.5, pan: 0 }] });
  const root = host();
  const mixer = mountMixer(root, { state, editTrack, editMaster });
  own(() => mixer.dispose());
  const pan = root.querySelector<HTMLInputElement>('input[aria-label="A pan"]')!;
  pan.focus();
  state.value = { tracks: [{ id: "a", name: "A", volume: 0.5, pan: 0.2, muted: false, solo: false }], masterVolume: 0 };
  expect(root.querySelector('input[aria-label="A pan"]')).toBe(pan);
  expect(document.activeElement).toBe(pan);
  expect(pan.valueAsNumber).toBe(0.2);
  const master = root.querySelector<HTMLInputElement>(".master input")!;
  expect(master.valueAsNumber).toBe(0);
  const mute = root.querySelector<HTMLButtonElement>(".mute")!;
  const solo = root.querySelector<HTMLButtonElement>(".solo")!;
  mute.click();
  solo.click();
  expect(editTrack.mock.calls).toEqual([
    ["a", { muted: true }],
    ["a", { solo: true }],
  ]);
  expect(mute.getAttribute("aria-pressed")).toBe("false");
  expect(state.value.tracks[0].solo).toBe(false);
  master.value = "0.7";
  master.dispatchEvent(new Event("input", { bubbles: true }));
  expect(editMaster).toHaveBeenCalledWith(0.7);
  expect(state.value.masterVolume).toBe(0);
  state.value = { tracks: [{ id: "a", name: "A", volume: 0.9, pan: 0.2, muted: true }] };
  expect(root.querySelector(".mute")).toBe(mute);
  expect(mute.getAttribute("aria-pressed")).toBe("true");
  expect(root.querySelector(".solo")).toBeNull();
  expect(root.querySelector(".master")).toBeNull();
  expect(document.activeElement).toBe(pan);
});

test("callback meters and appended controls release once while borrowed owners remain usable", async () => {
  const peak = cell(-20);
  const read = vi.fn(() => peak.value);
  const released: Array<string | null> = [];
  const detach = vi.fn();
  const { source, root, mixer } = mounted({
    meter: (id) => ({ source: read, dispose: () => released.push(id) }),
    appendControls: () => detach,
  });
  const trackMeter = root.querySelector('[data-track-id="a"] .ar-level-meter')!;
  const trackText = trackMeter.textContent;
  source.value = { tracks: [] };
  expect(released.sort()).toEqual(["a", null].sort());
  expect(detach).toHaveBeenCalledTimes(1);
  mixer.dispose();
  mixer.dispose();
  const count = read.mock.calls.length;
  peak.value = 0;
  source.value = { tracks: [track("a")], masterVolume: 1 };
  await new Promise(requestAnimationFrame);
  expect(read).toHaveBeenCalledTimes(count);
  expect(released).toHaveLength(2);
  expect(trackMeter.textContent).toBe(trackText);
  expect(root.children).toHaveLength(0);
  expect(peak.value).toBe(0);
  expect(source.value.tracks).toHaveLength(1);
});
