import { cell } from "@audiorective/core";
import { attachTimelineZoom, type TimelineZoomOptions } from "../src/arrangement";
import { attachClipGesture, type ClipGestureOptions } from "../src/clip";

export function arrangementContracts(element: HTMLElement, timeMap: ClipGestureOptions["timeMap"]): void {
  const source = cell<{ time: number; trackId: string } | undefined>({ time: 1, trackId: "a" });
  const options: ClipGestureOptions = {
    clipId: "clip-a",
    origin: () => source.value,
    timeMap,
    pixelsPerSecond: () => 100,
    trackAt: () => undefined,
    onSelect() {},
    onOpen() {},
    onMove(move) {
      source.value = { time: move.time, trackId: move.trackId };
    },
  };
  const gesture = attachClipGesture(element, options);
  source.value = undefined;
  gesture.dispose();
  // @ts-expect-error A static origin object cannot follow owner changes.
  const staticOrigin: ClipGestureOptions = { ...options, origin: { time: 1, trackId: "a" } };
  void staticOrigin;
  // @ts-expect-error Old snapshot options are removed.
  const legacy: ClipGestureOptions = { ...options, time: 1, trackId: "a" };
  void legacy;
  const zoomOptions: TimelineZoomOptions = { viewport: element, ruler: () => element, getScale: () => 100, onScale() {} };
  attachTimelineZoom(zoomOptions).dispose();
  // @ts-expect-error The scalar reader is a tracked callback, not a second cell binding form.
  const invalidScale: TimelineZoomOptions = { ...zoomOptions, getScale: cell(100) };
  void invalidScale;
}

export type NoLegacySnapshotKeys = Extract<keyof ClipGestureOptions, "time" | "trackId"> extends never ? true : never;
export const noLegacySnapshotKeys: NoLegacySnapshotKeys = true;
