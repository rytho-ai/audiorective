import { describe, expect, test } from "vitest";
import { effect } from "@audiorective/core";
import { ClipLauncher, type ClipLaunchTransport } from "../src/ClipLauncher";
import * as clipLauncherSourceModule from "../src/ClipLauncher.ts?raw";
import { coverageGaps, watch } from "../../../scripts/tracking-coverage.mjs";

const touched = {
  clipLauncher: new Set<string>(),
};

describe("command methods called inside an effect do not subscribe it", () => {
  test("ClipLauncher.queue, cancel and advance", () => {
    let now = 0;
    const transport: ClipLaunchTransport = {
      now: () => now,
      timeToBeat: (t) => t,
      beatToTime: (b) => b,
      schedule: () => ({ cancel() {}, commit() {} }),
      reset() {},
    };
    const launcher = watch(new ClipLauncher(transport), touched.clipLauncher);
    let runs = 0;
    const stop = effect(() => {
      runs++;
      launcher.queue([{ trackId: "a", clipId: "x" }]);
      launcher.advance();
      launcher.cancel();
    });
    launcher.queue([{ trackId: "a", clipId: "y" }]);
    now = 5;
    launcher.advance();
    launcher.reset();
    stop();
    expect(runs).toBe(1);
  });
});

describe("every public member of a tracked block is covered", () => {
  test.each([["ClipLauncher", ClipLauncher, clipLauncherSourceModule.default, touched.clipLauncher, {}]] as const)(
    "%s",
    (_name, ctor, source, seen, excluded) => {
      expect(coverageGaps(ctor, source, seen, excluded)).toEqual([]);
    },
  );
});
