/**
 * A widget's reactive bindings live until the widget is disposed, not until the effect that mounted it re-runs (`src/detached-effect.ts`).
 * Each case mounts one widget inside a caller's effect, re-runs that effect, then changes a tracked source the widget reads and expects the
 * widget to follow it.
 */
import { Param, cell, effect, readonlyCell } from "@audiorective/core";
import { afterEach, describe, expect, test } from "vitest";
import {
  mountAutomationLane,
  mountClipEnvelopeEditor,
  mountMixer,
  mountParameter,
  mountSampleBrowser,
  type MixerState,
  type SampleBrowserState,
} from "../src";
import { attachClipWaveform } from "../src/clip";
import { attachTimelineZoom, mountBarRuler } from "../src/arrangement";
import { cleanup, host, own } from "./helpers";

afterEach(cleanup);

type Mounted = { dispose(): void };
type Case = {
  name: string;
  /**
   * Sets up the widget's model outside any effect and returns the mount call; `source` is the tracked cell the widget reads, `seen()` reports
   * what the widget currently shows of it.
   */
  prepare(root: HTMLElement, source: ReturnType<typeof cell<number>>): () => { widget: Mounted; seen(): unknown };
};

const flatCurve = (value: number) => ({ value: [{ time: 0, value, shape: "linear" as const }] });
const constant = (bpm: number) => ({ beatToSeconds: (beat: number) => (beat * 60) / bpm, secondsToBeat: (seconds: number) => (seconds * bpm) / 60 });

/** A model that follows `source` through an effect of its own, made outside the effect under test. */
function derived<T>(initial: T, from: (value: number) => T, source: ReturnType<typeof cell<number>>) {
  const model = cell<T>(initial);
  own(effect(() => void (model.value = from(source.value))));
  return model;
}
const track = (i: number) => ({ id: `t${i}`, name: `t${i}`, volume: 1, pan: 0, muted: false, solo: false });
const sample = (i: number) => ({ id: `s${i}`, name: `s${i}`, status: "ready" as const, duration: 1 });

const cases: Case[] = [
  {
    name: "mountParameter",
    prepare(root, source) {
      const param = new Param({ default: 0, min: 0, max: 100 });
      own(() => param.dispose());
      own(effect(() => void (param.value = source.value)));
      return () => ({ widget: mountParameter(root, { param }), seen: () => root.querySelector("input")!.valueAsNumber });
    },
  },
  {
    name: "mountClipEnvelopeEditor",
    prepare(root, source) {
      const envelope = derived({ gain: 1, fadeIn: 0, fadeOut: 0 }, (gain) => ({ gain, fadeIn: 0, fadeOut: 0 }), source);
      return () => ({
        widget: mountClipEnvelopeEditor(root, { duration: () => 8, envelope, onChange: () => {} }),
        seen: () => root.querySelector("input")!.value,
      });
    },
  },
  {
    name: "mountMixer",
    prepare(root, source) {
      const state = derived<MixerState>(
        { tracks: [], masterVolume: 1 },
        (n) => ({ tracks: Array.from({ length: n }, (_, i) => track(i)), masterVolume: 1 }),
        source,
      );
      return () => ({
        widget: mountMixer(root, { state: readonlyCell(state), editTrack: () => {}, editMaster: () => {} }),
        seen: () => root.querySelectorAll("[data-track-id]").length,
      });
    },
  },
  {
    name: "mountSampleBrowser",
    prepare(root, source) {
      const state = derived<SampleBrowserState>(
        { rows: [], previewId: null, previewPlaying: false },
        (n) => ({ rows: Array.from({ length: n }, (_, i) => sample(i)), previewId: null, previewPlaying: false }),
        source,
      );
      return () => ({
        widget: mountSampleBrowser(root, {
          library: { state: readonlyCell(state), preview: async () => {}, stopPreview: () => {}, remove: () => {} },
          choose: () => {},
          onError: () => {},
        }),
        seen: () => root.querySelectorAll("li").length,
      });
    },
  },
  {
    name: "mountBarRuler",
    prepare(root, source) {
      return () => {
        const widget = mountBarRuler(root, { tempoMap: constant(120), pixelsPerSecond: () => 100 + source.value, duration: () => 8 });
        return { widget, seen: () => widget.element.style.width };
      };
    },
  },
  {
    name: "mountAutomationLane",
    prepare(root, source) {
      return () => {
        let reads = 0;
        const widget = mountAutomationLane(root, {
          duration: () => (reads++, 4 + source.value * 0),
          points: flatCurve(1),
          maxValue: 2,
          defaultValue: 1,
          onCommit: () => {},
        });
        return { widget, seen: () => reads };
      };
    },
  },
  {
    name: "attachClipWaveform",
    prepare(root, source) {
      return () => {
        let reads = 0;
        const clip = () => {
          reads++;
          void source.value;
          return { data: { sampleRate: 100, channels: [new Float32Array(100)] }, sourceOffset: 0, duration: 1 };
        };
        return { widget: attachClipWaveform(root, { clip } as Parameters<typeof attachClipWaveform>[1]), seen: () => reads };
      };
    },
  },
  {
    name: "attachTimelineZoom",
    prepare(root, source) {
      return () => {
        let reads = 0;
        const getScale = () => (reads++, 100 + source.value * 0);
        return { widget: attachTimelineZoom({ viewport: root, getScale, onScale: () => {} }), seen: () => reads };
      };
    },
  },
];

describe("a widget mounted inside an effect keeps following its sources after that effect re-runs", () => {
  test.each(cases)("$name", ({ prepare }) => {
    const root = host();
    const outer = cell(0);
    const source = cell(1);
    const mount = prepare(root, source);
    let mounted: ReturnType<typeof mount> | undefined;
    const stop = effect(() => {
      void outer.value;
      mounted ??= mount();
    });
    own(() => {
      stop();
      mounted?.widget.dispose();
    });
    const first = mounted!.seen();
    outer.value = 1; // the effect that mounted the widget runs again
    source.value = 3;
    expect(mounted!.seen(), "the widget did not follow its source").not.toEqual(first);
    const second = mounted!.seen();
    outer.value = 2;
    source.value = 5;
    expect(mounted!.seen()).not.toEqual(second);
  });
});
