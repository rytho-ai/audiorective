import { expect, test } from "vitest";
import * as arrangement from "../src/arrangement";
import * as clip from "../src/clip";

test("attachClipGesture is exported by widgets/clip and not by widgets/arrangement", () => {
  expect("attachClipGesture" in arrangement).toBe(false);
  expect(typeof clip.attachClipGesture).toBe("function");
});
