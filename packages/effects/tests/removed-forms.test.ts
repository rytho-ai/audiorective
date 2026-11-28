import { expect, test } from "vitest";
import * as effects from "../src";

test("the effects root does not export registerWorklet or TimeStretch", () => {
  // @ts-expect-error `registerWorklet` lives in @audiorective/core; the effects root no longer re-exports it.
  expect(effects.registerWorklet).toBeUndefined();
  // @ts-expect-error `TimeStretch` lives in the `@audiorective/effects/time-stretch` entry; the effects root no longer exports it.
  expect(effects.TimeStretch).toBeUndefined();
  expect("registerWorklet" in effects).toBe(false);
  expect("TimeStretch" in effects).toBe(false);
});
