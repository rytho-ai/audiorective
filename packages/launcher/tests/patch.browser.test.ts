import { expect, expectTypeOf, test } from "vitest";
import { ClipLauncher, type Clip, type ClipPatch } from "../src/ClipLauncher";
import { rig, tone } from "./helpers";

test("configure takes a writable ClipPatch that can be built step by step", () => {
  const { ctx } = rig(1);
  const l = new ClipLauncher({ t: [{ buffer: tone(ctx, 200) }] }, { context: ctx });
  const clip = l.tracks.t!.clips[0]!;
  expectTypeOf<Parameters<Clip["configure"]>[0]>().toEqualTypeOf<ClipPatch>();
  const patch: Parameters<Clip["configure"]>[0] = {};
  patch.loop = true;
  patch.quantize = null;
  patch.length = null;
  patch.follow = null;
  patch.chance = 0.5;
  clip.configure(patch);
  expect(clip.options.value.loop).toBe(true);
  expect(clip.options.value.quantize).toBeNull();
  expect(clip.options.value.chance).toBe(0.5);
});
