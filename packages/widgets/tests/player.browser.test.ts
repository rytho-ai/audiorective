import { afterEach, expect, test, vi } from "vitest";
import { BufferPlayer, cell, FilePlayer } from "@audiorective/core";
import { WavePlayer } from "@audiorective/blocks";
import { silentWavUrl } from "./player-wav";
import { fromBufferPlayer, fromFilePlayer, fromWavePlayer, mountPlayer } from "../src/player";
import type { PlayerActions, PlayerFrame, PlayerLike, PlayerRenderer } from "../src/player";

const disposers: Array<() => void | Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const frames = async (count = 3) => {
  for (let i = 0; i < count; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
};
async function until(check: () => boolean, label: string, ms = 4000): Promise<void> {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > ms) throw new Error(`Timed out waiting for: ${label}`);
    await sleep(15);
  }
}
function host(): HTMLElement {
  const root = document.createElement("div");
  document.body.append(root);
  disposers.push(() => root.remove());
  return root;
}
function context(): AudioContext {
  const ctx = new AudioContext();
  disposers.push(() => ctx.close());
  return ctx;
}
function parts(root: HTMLElement) {
  const q = <T extends Element>(id: string) => root.querySelector<T>(`[data-testid=${id}]`)!;
  return {
    toggle: q<HTMLButtonElement>("play-toggle"),
    seek: q<HTMLInputElement>("seek"),
    time: q<HTMLElement>("time"),
    volume: q<HTMLInputElement>("volume"),
    notice: q<HTMLElement>("notice"),
  };
}
/** A FilePlayer routed to the destination (an unrouted media element source does not advance) with a silent track. */
async function track(seconds = 200) {
  const ctx = context();
  const player = new FilePlayer(ctx, { volume: 0.8 });
  player.output.connect(ctx.destination);
  const url = silentWavUrl(seconds);
  disposers.push(
    () => player.destroy(),
    () => URL.revokeObjectURL(url),
  );
  player.src = url;
  await until(() => Number.isFinite(player.cells.duration.value), "metadata");
  return { ctx, player };
}
function blockPlay(player: FilePlayer, name: string): () => void {
  player.audio.play = () => Promise.reject(new DOMException("simulated", name));
  return () => {
    delete (player.audio as { play?: unknown }).play;
  };
}
/** A renderer that records frames and hands the actions to the test. */
function recorder() {
  const seen: PlayerFrame[] = [];
  let actions!: PlayerActions;
  const destroy = vi.fn();
  const renderer: PlayerRenderer = (_container, given) => {
    actions = given;
    return { render: (frame) => void seen.push(frame), destroy };
  };
  return { seen, renderer, destroy, last: () => seen[seen.length - 1], actions: () => actions };
}
/** A player made of plain cells, for logic tests that need no audio. */
function fake(overrides: Partial<PlayerLike> = {}) {
  const isPlaying = cell(false);
  const position = cell(0);
  const duration = cell(100);
  const volume = cell(0.5);
  const seek = vi.fn((seconds: number) => {
    position.value = seconds;
  });
  const play = vi.fn<() => void | Promise<void>>(() => {
    isPlaying.value = true;
  });
  const pause = vi.fn(() => {
    isPlaying.value = false;
  });
  const player: PlayerLike = { isPlaying, play, pause, volume, timeline: { position: () => position.value, duration, seek }, ...overrides };
  return { player, isPlaying, position, duration, volume, seek, play, pause };
}

// ---------------------------------------------------------------- FilePlayer, default renderer

test("FilePlayer: shows state, follows changes made elsewhere, toggles and sets volume", async () => {
  const { player } = await track(200);
  const root = host();
  const view = mountPlayer(root, { player: fromFilePlayer(player) });
  disposers.push(() => view.destroy());
  const ui = parts(root);

  expect(ui.toggle.textContent).toBe("Play");
  expect(ui.time.textContent).toBe("0:00 / 3:20");
  expect(ui.seek.disabled).toBe(false);
  expect(ui.seek.max).toBe("200");
  expect(ui.volume.valueAsNumber).toBeCloseTo(0.8);
  expect(ui.notice.hidden).toBe(true);

  await player.play(); // elsewhere in the app
  await until(() => ui.toggle.textContent === "Pause", "external play");
  player.seek(65);
  await until(() => ui.time.textContent === "1:05 / 3:20", "external seek");
  expect(Math.floor(ui.seek.valueAsNumber)).toBe(65);
  player.pause();
  await until(() => ui.toggle.textContent === "Play", "external pause");

  ui.toggle.click();
  await until(() => !player.audio.paused && ui.toggle.textContent === "Pause", "toggle plays");
  ui.toggle.click();
  await until(() => player.audio.paused && ui.toggle.textContent === "Play", "toggle pauses");

  ui.volume.value = "0.3";
  ui.volume.dispatchEvent(new Event("input", { bubbles: true }));
  expect(player.params.volume.value).toBeCloseTo(0.3);
  player.params.volume.value = 0.7;
  expect(ui.volume.valueAsNumber).toBeCloseTo(0.7);
});

test("(a) a drag is not yanked by time updates and seeks once, on release", async () => {
  const { player } = await track(200);
  const root = host();
  const view = mountPlayer(root, { player: fromFilePlayer(player) });
  disposers.push(() => view.destroy());
  const ui = parts(root);
  const seek = vi.spyOn(player, "seek");
  await player.play();
  await until(() => player.cells.currentTime.value > 0.2, "playing");

  ui.seek.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  ui.seek.value = "120";
  ui.seek.dispatchEvent(new Event("input", { bubbles: true }));
  const before = player.cells.currentTime.value;
  await until(() => player.cells.currentTime.value > before + 0.3, "time updates during the drag");
  expect(ui.seek.value).toBe("120");
  expect(ui.time.textContent).toBe("2:00 / 3:20"); // previews the target
  expect(seek).not.toHaveBeenCalled();
  expect(player.audio.currentTime).toBeLessThan(5);

  ui.seek.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  ui.seek.dispatchEvent(new Event("change", { bubbles: true }));
  expect(seek).toHaveBeenCalledTimes(1);
  expect(seek).toHaveBeenCalledWith(120);
  expect(player.audio.currentTime).toBeGreaterThanOrEqual(120);
  await until(() => ui.seek.valueAsNumber > 120.2, "follows the player again");
});

test("(a) logic: hold freezes, scrub previews, commit seeks, cancel and a press without movement do not seek", () => {
  const f = fake();
  const r = recorder();
  const view = mountPlayer(host(), { player: f.player, renderer: r.renderer });
  disposers.push(() => view.destroy());
  f.position.value = 10;
  expect(r.last().position).toBe(10);

  r.actions().hold();
  f.position.value = 11;
  expect(r.last()).toMatchObject({ position: 10, scrubbing: true });
  r.actions().commit(); // released without moving
  expect(f.seek).not.toHaveBeenCalled();
  expect(r.last()).toMatchObject({ position: 11, scrubbing: false });

  r.actions().scrub(40);
  f.position.value = 12;
  expect(r.last()).toMatchObject({ position: 40, scrubbing: true });
  r.actions().scrub(500); // clamped to the duration
  expect(r.last().position).toBe(100);
  r.actions().cancel();
  expect(f.seek).not.toHaveBeenCalled();
  expect(r.last()).toMatchObject({ position: 12, scrubbing: false });

  r.actions().scrub(40);
  r.actions().commit();
  r.actions().commit(); // pointerup then change: the second is a no-op
  expect(f.seek).toHaveBeenCalledTimes(1);
  expect(f.seek).toHaveBeenCalledWith(40);
  expect(r.last()).toMatchObject({ position: 40, scrubbing: false });
  f.position.value = 41; // still subscribed after a gesture
  expect(r.last().position).toBe(41);

  r.actions().scrub(60);
  f.duration.value = NaN; // the track changed mid-gesture
  expect(r.last()).toMatchObject({ scrubbing: false, canSeek: false, duration: null });
  r.actions().commit();
  expect(f.seek).toHaveBeenCalledTimes(1);
});

test("a drag commits within the latest duration when the track becomes shorter", () => {
  const f = fake();
  const r = recorder();
  const view = mountPlayer(host(), { player: f.player, renderer: r.renderer });
  disposers.push(() => view.destroy());

  r.actions().scrub(90);
  f.duration.value = 10;
  expect(r.last()).toMatchObject({ position: 10, duration: 10, scrubbing: true });
  r.actions().commit();
  expect(f.seek).toHaveBeenCalledExactlyOnceWith(10);
});

test("(b) unknown length: before metadata, live stream, track switch; never renders NaN", async () => {
  const ctx = context();
  const player = new FilePlayer(ctx);
  disposers.push(() => player.destroy());
  const root = host();
  const view = mountPlayer(root, { player: fromFilePlayer(player) });
  disposers.push(() => view.destroy());
  const ui = parts(root);
  const clean = () => !/NaN|Infinity/.test(root.textContent ?? "") && !/NaN|Infinity/.test(ui.seek.max + ui.seek.value);

  expect(ui.time.textContent).toBe("0:00 / --:--");
  expect(ui.seek.disabled).toBe(true);
  expect(clean()).toBe(true);

  player.cells.duration.value = Infinity; // live stream
  player.cells.currentTime.value = 75;
  expect(ui.time.textContent).toBe("1:15 / --:--");
  expect(ui.seek.disabled).toBe(true);
  expect(clean()).toBe(true);

  // A drag cannot start while the length is unknown.
  ui.seek.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  ui.seek.dispatchEvent(new Event("input", { bubbles: true }));
  player.cells.currentTime.value = 76;
  expect(ui.time.textContent).toBe("1:16 / --:--");

  player.cells.duration.value = 200;
  expect(ui.time.textContent).toBe("1:16 / 3:20");
  expect(ui.seek.disabled).toBe(false);
  expect(ui.seek.valueAsNumber).toBe(76);

  player.src = null; // resets duration to NaN
  expect(ui.time.textContent).toBe("0:00 / --:--");
  expect(ui.seek.disabled).toBe(true);

  for (const odd of [0, -1, -Infinity]) {
    player.cells.duration.value = odd;
    expect(ui.seek.disabled).toBe(true);
    expect(ui.time.textContent).toBe("0:00 / --:--");
  }
  player.cells.duration.value = 50;
  player.cells.currentTime.value = NaN;
  expect(ui.time.textContent).toBe("0:00 / 0:50");
  player.cells.currentTime.value = 999; // past the end: clamped
  expect(ui.time.textContent).toBe("0:50 / 0:50");
  expect(clean()).toBe(true);
});

test("(b) mounted mid-track, the slider is at the real position (max is set before value)", async () => {
  const { player } = await track(200);
  player.seek(150);
  const root = host();
  const view = mountPlayer(root, { player: fromFilePlayer(player) });
  disposers.push(() => view.destroy());
  expect(parts(root).seek.valueAsNumber).toBe(150);
  expect(parts(root).time.textContent).toBe("2:30 / 3:20");
});

test("(c) a blocked play from the widget is shown, and cleared when playback next starts", async () => {
  const { player } = await track(30);
  const root = host();
  const view = mountPlayer(root, { player: fromFilePlayer(player) });
  disposers.push(() => view.destroy());
  const ui = parts(root);
  const unblock = blockPlay(player, "NotAllowedError");

  ui.toggle.click();
  await until(() => !ui.notice.hidden, "notice");
  expect(ui.notice.textContent).toMatch(/blocked/i);
  expect(ui.notice.getAttribute("role")).toBe("alert");
  expect(ui.toggle.textContent).toBe("Play");
  expect(player.cells.isPlaying.value).toBe(false);

  unblock();
  ui.toggle.click();
  await until(() => ui.toggle.textContent === "Pause", "plays");
  expect(ui.notice.hidden).toBe(true);
});

test("(c) an interrupted play (AbortError) is not reported; other failures and an empty player are", async () => {
  const { player } = await track(30);
  const root = host();
  const view = mountPlayer(root, { player: fromFilePlayer(player) });
  disposers.push(() => view.destroy());
  const ui = parts(root);

  let restore = blockPlay(player, "AbortError");
  ui.toggle.click();
  await frames(5);
  expect(ui.notice.hidden).toBe(true);
  restore();

  restore = blockPlay(player, "NotSupportedError");
  ui.toggle.click();
  await until(() => !ui.notice.hidden, "failure notice");
  expect(ui.notice.textContent).toMatch(/could not start/i);
  restore();

  await player.play(); // started elsewhere: the reason no longer applies
  await until(() => ui.notice.hidden, "notice cleared by an external start");
  player.pause();
  await until(() => ui.toggle.textContent === "Play", "paused");

  player.src = null;
  ui.toggle.click();
  await until(() => !ui.notice.hidden, "empty notice");
  expect(ui.notice.textContent).toMatch(/no track/i);
});

test("(c) a superseded attempt cannot raise a stale notice", async () => {
  let reject!: (reason: unknown) => void;
  const f = fake({ play: () => new Promise<void>((_resolve, fail) => (reject = fail)) });
  const r = recorder();
  const view = mountPlayer(host(), { player: f.player, renderer: r.renderer });
  disposers.push(() => view.destroy());
  r.actions().toggle();
  const first = reject;
  r.actions().toggle(); // a second attempt supersedes the first
  first(new DOMException("late", "NotAllowedError"));
  await frames(2);
  expect(r.last().notice).toBeNull();
  reject(new DOMException("current", "NotAllowedError"));
  await until(() => r.last().notice !== null, "current attempt reported");
});

test("a late rejection does not restore a notice after another view starts playback", async () => {
  let reject!: (reason: unknown) => void;
  const f = fake({ play: () => new Promise<void>((_resolve, fail) => (reject = fail)) });
  const r = recorder();
  const view = mountPlayer(host(), { player: f.player, renderer: r.renderer });
  disposers.push(() => view.destroy());

  r.actions().toggle();
  f.isPlaying.value = true;
  reject(new DOMException("late", "NotAllowedError"));
  await frames(2);
  expect(r.last().notice).toBeNull();
});

test("(c) limitation: a blocked FilePlayer.play() made elsewhere leaves nothing to observe", async () => {
  const { player } = await track(30);
  const root = host();
  const view = mountPlayer(root, { player: fromFilePlayer(player) });
  disposers.push(() => view.destroy());
  const r = { events: [] as string[] };
  for (const type of ["play", "playing", "pause", "error", "abort", "stalled", "suspend", "waiting"]) {
    player.audio.addEventListener(type, () => r.events.push(type));
  }
  blockPlay(player, "NotAllowedError");

  // The app calls the documented method. It resolves; no cell changes; the element fires nothing.
  await expect(player.play()).resolves.toBeUndefined();
  await frames(5);
  expect(player.cells.isPlaying.value).toBe(false);
  expect(player.audio.error).toBeNull();
  expect(r.events).toEqual([]);
  expect(parts(root).notice.hidden).toBe(true); // the widget has no way to know

  // "Not playing after play() resolved" does not identify a block: an interrupted play looks the same.
  blockPlay(player, "AbortError");
  await expect(player.play()).resolves.toBeUndefined();
  expect(player.cells.isPlaying.value).toBe(false);
});

test("(d) unmount leaves audio and the player untouched and releases everything", async () => {
  const { player } = await track(30);
  const root = host();
  const r = recorder();
  const view = mountPlayer(root, { player: fromFilePlayer(player), renderer: r.renderer });
  const second = host();
  const plain = mountPlayer(second, { player: fromFilePlayer(player) });
  const old = parts(second);
  await player.play();
  await until(() => player.cells.currentTime.value > 0.2, "playing");
  const pause = vi.spyOn(player, "pause");
  const stop = vi.spyOn(player, "stop");
  const destroy = vi.spyOn(player, "destroy");
  const elementPause = vi.spyOn(player.audio, "pause");

  view.destroy();
  plain.destroy();
  view.destroy(); // idempotent
  expect(root.childElementCount).toBe(0);
  expect(second.childElementCount).toBe(0);
  expect(r.destroy).toHaveBeenCalledTimes(1);
  expect(pause).not.toHaveBeenCalled();
  expect(stop).not.toHaveBeenCalled();
  expect(destroy).not.toHaveBeenCalled();
  expect(elementPause).not.toHaveBeenCalled();
  expect(player.audio.paused).toBe(false);
  expect(player.cells.isPlaying.value).toBe(true);

  // Effects are gone: state keeps changing, nothing is drawn.
  const drawn = r.seen.length;
  const text = old.time.textContent;
  const at = player.cells.currentTime.value;
  await until(() => player.cells.currentTime.value > at + 0.3, "still playing after unmount");
  player.params.volume.value = 0.2;
  expect(r.seen.length).toBe(drawn);
  expect(old.time.textContent).toBe(text);

  // Actions are dead: a detached control or a retained actions object does nothing.
  old.toggle.click();
  r.actions().toggle();
  r.actions().scrub(5);
  r.actions().commit();
  r.actions().setVolume(1);
  expect(player.audio.paused).toBe(false);
  expect(player.params.volume.value).toBeCloseTo(0.2);

  // The player is still fully usable by its owner.
  player.pause();
  await until(() => !player.cells.isPlaying.value, "owner can still pause");
});

test("(d) unmount stops the subscription and the animation frames of a clock player", async () => {
  const listeners = new Set<() => void>();
  let clock = 0;
  const f = fake({
    timeline: { position: () => clock, clock: true, duration: cell(100) },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const r = recorder();
  const request = vi.spyOn(window, "requestAnimationFrame");
  const view = mountPlayer(host(), { player: f.player, renderer: r.renderer });
  expect(listeners.size).toBe(1);
  expect(request).not.toHaveBeenCalled(); // no frames while stopped

  clock = 3; // an untracked change, announced through subscribe
  for (const listener of listeners) listener();
  expect(r.last().position).toBe(3);

  f.isPlaying.value = true;
  clock = 4;
  await until(() => r.last().position === 4, "clock read per frame while playing");
  f.isPlaying.value = false;
  await frames(3);
  const idle = request.mock.calls.length;
  await frames(3);
  expect(request.mock.calls.length).toBe(idle + 3); // only this test's own frames() calls

  f.isPlaying.value = true;
  await frames(2);
  view.destroy();
  expect(listeners.size).toBe(0);
  const drawn = r.seen.length;
  clock = 9;
  await frames(4);
  expect(r.seen.length).toBe(drawn);
});

// ---------------------------------------------------------------- WavePlayer

test("WavePlayer: unknown until loaded, clock position, paused seek via subscribe, slider seek", async () => {
  const ctx = context();
  const player = new WavePlayer(ctx);
  disposers.push(() => player.destroy());
  const root = host();
  const view = mountPlayer(root, { player: fromWavePlayer(player) });
  disposers.push(() => view.destroy());
  const ui = parts(root);

  expect(ui.time.textContent).toBe("0:00 / --:--");
  expect(ui.seek.disabled).toBe(true);
  ui.toggle.click();
  await until(() => !ui.notice.hidden, "nothing loaded notice");
  expect(ui.notice.textContent).toMatch(/no audio/i);

  await player.load(ctx.createBuffer(1, ctx.sampleRate * 90, ctx.sampleRate));
  expect(ui.time.textContent).toBe("0:00 / 1:30");
  expect(ui.seek.disabled).toBe(false);

  player.seek(70); // paused: no cell changes, only subscribe() reports it
  expect(ui.time.textContent).toBe("1:10 / 1:30");
  expect(ui.seek.valueAsNumber).toBe(70);

  ui.toggle.click();
  await until(() => ui.toggle.textContent === "Pause", "playing");
  expect(ui.notice.hidden).toBe(true);
  await until(() => ui.seek.valueAsNumber > 70.3, "position follows the audio clock");

  ui.seek.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  ui.seek.value = "20";
  ui.seek.dispatchEvent(new Event("input", { bubbles: true }));
  await frames(6);
  expect(ui.seek.value).toBe("20"); // per-frame clock reads do not yank it
  expect(player.position).toBeGreaterThan(70);
  ui.seek.dispatchEvent(new Event("change", { bubbles: true }));
  expect(player.position).toBeGreaterThanOrEqual(20);
  expect(player.position).toBeLessThan(21);

  ui.toggle.click();
  await until(() => ui.toggle.textContent === "Play", "paused");
  expect(player.cells.isPlaying.value).toBe(false);

  view.destroy();
  await player.play();
  expect(player.cells.isPlaying.value).toBe(true); // borrowed: still the owner's
});

// ---------------------------------------------------------------- BufferPlayer

test("BufferPlayer: start/stop and volume only; no seek bar, no time, control reads Stop", async () => {
  const ctx = context();
  const player = new BufferPlayer(ctx);
  disposers.push(() => player.destroy());
  const root = host();
  const view = mountPlayer(root, { player: fromBufferPlayer(player) });
  disposers.push(() => view.destroy());
  const ui = parts(root);

  expect(ui.seek.hidden).toBe(true);
  expect(ui.time.hidden).toBe(true);
  expect(ui.volume.hidden).toBe(false);

  ui.toggle.click();
  await until(() => !ui.notice.hidden, "no buffer notice");
  expect(player.cells.isPlaying.value).toBe(false);

  player.buffer = ctx.createBuffer(1, ctx.sampleRate * 5, ctx.sampleRate);
  ui.toggle.click();
  await until(() => ui.toggle.textContent === "Stop", "started");
  expect(player.cells.isPlaying.value).toBe(true);
  expect(ui.notice.hidden).toBe(true);
  ui.toggle.click();
  expect(ui.toggle.textContent).toBe("Play");
  expect(player.cells.isPlaying.value).toBe(false);

  player.start(); // started elsewhere
  expect(ui.toggle.textContent).toBe("Stop");
  ui.volume.value = "0.25";
  ui.volume.dispatchEvent(new Event("input", { bubbles: true }));
  expect(player.params.volume.value).toBeCloseTo(0.25);

  view.destroy();
  expect(player.cells.isPlaying.value).toBe(true);
});

// ---------------------------------------------------------------- renderer seam and minimal players

test("renderer seam: a custom renderer gets frames and actions; the logic is not re-implemented", () => {
  const f = fake();
  const root = host();
  const view = mountPlayer(root, {
    player: f.player,
    label: "Deck A",
    renderer: (container, actions) => {
      const button = document.createElement("button");
      button.onclick = () => actions.toggle();
      container.append(button);
      return {
        render(frame) {
          button.textContent = `${frame.isPlaying ? "on" : "off"} ${frame.position}/${frame.duration} v${frame.volume}`;
        },
      };
    },
  });
  disposers.push(() => view.destroy());
  const button = root.querySelector("button")!;
  expect(root.querySelector("[role=group]")!.getAttribute("aria-label")).toBe("Deck A");
  expect(button.textContent).toBe("off 0/100 v0.5");
  button.click();
  expect(f.play).toHaveBeenCalledTimes(1);
  expect(button.textContent).toBe("on 0/100 v0.5");
  button.click();
  expect(f.pause).toHaveBeenCalledTimes(1);
  view.destroy();
  expect(root.childElementCount).toBe(0);
});

test("a player with only isPlaying/play/pause mounts; a throwing renderer leaves nothing behind", () => {
  const isPlaying = cell(false);
  const r = recorder();
  const view = mountPlayer(host(), {
    player: { isPlaying, play: () => void (isPlaying.value = true), pause: () => void (isPlaying.value = false) },
    renderer: r.renderer,
  });
  disposers.push(() => view.destroy());
  expect(r.last()).toEqual({
    isPlaying: false,
    resumes: true,
    position: null,
    duration: null,
    canSeek: false,
    scrubbing: false,
    volume: null,
    notice: null,
  });
  r.actions().scrub(3);
  r.actions().commit();
  r.actions().setVolume(1);
  expect(r.last().scrubbing).toBe(false);

  const root = host();
  expect(() =>
    mountPlayer(root, {
      player: { isPlaying, play() {}, pause() {} },
      renderer: () => {
        throw new Error("boom");
      },
    }),
  ).toThrow("boom");
  expect(root.childElementCount).toBe(0);
});

test("an initial render failure releases its observer and the borrowed player", () => {
  const isPlaying = cell(false);
  const root = host();
  const render = vi.fn(() => {
    throw new Error("first render failed");
  });
  const destroy = vi.fn();

  expect(() =>
    mountPlayer(root, {
      player: { isPlaying, play() {}, pause() {} },
      renderer: () => ({ render, destroy }),
    }),
  ).toThrow("first render failed");
  expect(root.childElementCount).toBe(0);
  expect(destroy).toHaveBeenCalledTimes(1);

  isPlaying.value = true;
  expect(render).toHaveBeenCalledTimes(1);
});
