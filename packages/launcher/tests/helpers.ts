import { expect } from "vitest";
import { Clock, ManualTickSource } from "@audiorective/clock";
import type { ClipEvent } from "./contract";
import type { ClipLauncher, ClipEvent as LauncherEvent } from "../src/ClipLauncher";

/** Frequency in Hz over [t0, t1], from interpolated positive-going zero crossings; 0 when silent. */
export function freq(buf: AudioBuffer, t0: number, t1: number): number {
  const d = buf.getChannelData(0);
  const sr = buf.sampleRate;
  const a = Math.floor(t0 * sr);
  const b = Math.min(d.length - 1, Math.floor(t1 * sr));
  const xs: number[] = [];
  for (let i = a; i < b; i++) if (d[i]! < 0 && d[i + 1]! >= 0) xs.push(i + -d[i]! / (d[i + 1]! - d[i]!));
  if (xs.length < 3) return 0;
  return ((xs.length - 1) * sr) / (xs[xs.length - 1]! - xs[0]!);
}
export function rms(buf: AudioBuffer, t0: number, t1: number): number {
  const d = buf.getChannelData(0);
  const a = Math.floor(t0 * buf.sampleRate);
  const b = Math.floor(t1 * buf.sampleRate);
  let s = 0;
  for (let i = a; i < b; i++) s += d[i]! * d[i]!;
  return Math.sqrt(s / Math.max(1, b - a));
}
export const peakIn = (buf: AudioBuffer, t0: number, t1: number) => {
  const d = buf.getChannelData(0);
  let m = 0;
  for (let i = Math.floor(t0 * buf.sampleRate); i < Math.floor(t1 * buf.sampleRate); i++) m = Math.max(m, Math.abs(d[i]!));
  return m;
};
/** First frame (as seconds) at which the buffer leaves silence. */
export function onset(buf: AudioBuffer, from = 0): number {
  const d = buf.getChannelData(0);
  for (let i = Math.floor(from * buf.sampleRate); i < d.length; i++) if (Math.abs(d[i]!) > 1e-4) return i / buf.sampleRate;
  return -1;
}
/** Last audible frame, as seconds. */
export function lastSound(buf: AudioBuffer, from = 0): number {
  const d = buf.getChannelData(0);
  for (let i = d.length - 1; i >= Math.floor(from * buf.sampleRate); i--) if (Math.abs(d[i]!) > 1e-4) return (i + 1) / buf.sampleRate;
  return -1;
}
export const starts = (ev: ClipEvent[], clip?: number) => ev.filter((e) => e.kind === "start" && (clip === undefined || e.clip === clip));
export const stops = (ev: ClipEvent[], clip?: number) => ev.filter((e) => e.kind === "stop" && (clip === undefined || e.clip === clip));

export const SR = 44100;
/** Material: a sine whose frequency steps per beat (like the contract): beat b sounds at base * (1 + b/16); 16 beats at 120 BPM. */
export function tone(ctx: BaseAudioContext, base: number, beats = 16): AudioBuffer {
  const buf = new AudioBuffer({ length: Math.round(beats * 0.5 * ctx.sampleRate), sampleRate: ctx.sampleRate, numberOfChannels: 1 });
  const d = buf.getChannelData(0);
  let ph = 0;
  for (let i = 0; i < d.length; i++) {
    ph += (2 * Math.PI * base * (1 + Math.floor(i / ctx.sampleRate / 0.5) / 16)) / ctx.sampleRate;
    d[i] = 0.5 * Math.sin(ph);
  }
  return buf;
}
export type Rig = { ctx: OfflineAudioContext; clock: Clock; ticks: ManualTickSource };
export function rig(seconds: number, channels = 1): Rig {
  const ctx = new OfflineAudioContext(channels, Math.round(seconds * SR), SR);
  const ticks = new ManualTickSource();
  return { ctx, ticks, clock: new Clock({ context: ctx, tickSource: ticks, bpm: 120 }) };
}
export const record = (l: ClipLauncher, types: Array<"started" | "ended" | "skipped" | "cancelled" | "queued">) => {
  const log: Array<{ type: string; track: string; clip: number | null; when: number | null; off: number | null }> = [];
  for (const t of types)
    l.addEventListener(t, (e) =>
      log.push({
        type: t,
        track: (e as LauncherEvent).track.name,
        clip: (e as LauncherEvent).clip?.index ?? null,
        when: (e as LauncherEvent).when,
        off: (e as LauncherEvent).offsetBeats,
      }),
    );
  return log;
};
export const r3 = (x: number | null) => (x == null ? x : Math.round(x * 1000) / 1000);

export function near(a: number, b: number, tol = 0.01) {
  expect(Math.abs(a - b) / b).toBeLessThan(tol);
}
