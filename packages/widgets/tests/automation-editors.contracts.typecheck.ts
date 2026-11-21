import { readonlyCell, type Readable } from "@audiorective/core";
import type { AutomationCurve, AutomationPoint } from "@audiorective/core/automation";
import type { WaveStretchAnchor as PlayerAnchor } from "@audiorective/player";
import {
  createAutomationOverlay,
  createWarpMarkers,
  mountAutomationLane,
  mountClipEnvelopeEditor,
  type AutomationLaneOptions,
  type AutomationOverlayOptions,
  type ClipEnvelope,
  type WaveStretchAnchor,
} from "../src";

export const anchorIsTheOwnerType: PlayerAnchor extends WaveStretchAnchor ? true : never = true;
export const ownerTypeIsTheAnchor: WaveStretchAnchor extends PlayerAnchor ? true : never = true;

export function directCurveAndOwnerProjection(
  root: HTMLElement,
  curve: AutomationCurve,
  duration: Readable<number>,
  revision: Readable<number>,
  currentPoints: () => readonly AutomationPoint[],
  commit: (points: readonly AutomationPoint[]) => void,
  disabled: Readable<boolean>,
): void {
  const options: AutomationLaneOptions = {
    points: curve,
    duration: () => duration.value,
    timeUnit: "beats",
    defaultValue: 1,
    maxValue: 2,
    onCommit: commit,
  };
  const lane = mountAutomationLane(root, options);
  // @ts-expect-error The source is authoritative; there is no imperative synchronization API.
  lane.setPoints(curve.value);
  const projection = readonlyCell(() => {
    revision.$();
    return currentPoints();
  });
  mountAutomationLane(root, { ...options, points: projection, timeUnit: "seconds" });
  const overlay: AutomationOverlayOptions = {
    points: curve,
    fromView: (time) => time * 2,
    toView: (time) => time / 2,
    maxValue: 2,
    defaultValue: 1,
    onCommit: commit,
    disabled,
  };
  createAutomationOverlay(overlay);
  createAutomationOverlay({ ...overlay, points: projection });
  // @ts-expect-error Duration is a tracked callback, not a captured number.
  mountAutomationLane(root, { ...options, duration: 4 });
  // @ts-expect-error Arrays need an owner projection; they are not reactive source bindings.
  mountAutomationLane(root, { ...options, points: curve.value });
  // @ts-expect-error Points use readonly .value binding, not the alternate getter candidate.
  createAutomationOverlay({ ...overlay, points: () => curve.value });
  // @ts-expect-error The widget does not perform implicit unit conversion.
  mountAutomationLane(root, { ...options, timeUnit: "ticks" });
}

export function borrowedEnvelopeAndAnchors(
  root: HTMLElement,
  envelope: Readable<ClipEnvelope>,
  duration: Readable<number>,
  anchors: Readable<readonly PlayerAnchor[]>,
  onChange: (next: ClipEnvelope) => void,
  onCommit: (next: readonly PlayerAnchor[]) => void,
): void {
  mountClipEnvelopeEditor(root, { duration: () => duration.value, envelope, onChange });
  // @ts-expect-error Clip trim updates require a live duration callback.
  mountClipEnvelopeEditor(root, { duration: 4, envelope, onChange });
  createWarpMarkers({ anchors, sampleRate: 48_000, sourceFrames: 192_000, sourceFrameAt: (seconds) => seconds * 48_000, onCommit });
}
