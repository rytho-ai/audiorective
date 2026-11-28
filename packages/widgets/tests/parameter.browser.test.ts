import { Param } from "@audiorective/core";
import { afterEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { mountLevelMeter, mountParameter } from "../src";
import { cleanup, host, own, pointer } from "./helpers";

afterEach(cleanup);

test("a slider, fader and knob edit one Param and follow writes from elsewhere", async () => {
  const param = new Param({ default: 440, min: 20, max: 20_000, step: 10 });
  own(() => param.dispose());
  const slider = mountParameter(host(), { param });
  const fader = mountParameter(host(), { param, orientation: "vertical" });
  const knob = mountParameter(host(), { param, orientation: "rotary", scale: "log" });
  for (const control of [slider, fader, knob]) own(() => control.dispose());
  const first = slider.element.querySelector("input")!;
  const second = fader.element.querySelector("input")!;
  const dial = knob.element.querySelector<HTMLElement>("[role=slider]")!;
  first.focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(param.value).toBe(450);
  expect(second.valueAsNumber).toBe(450);
  expect(dial.getAttribute("aria-valuenow")).toBe("450");
  const rect = dial.getBoundingClientRect();
  await pointer({ action: "down", x: rect.left + 18, y: rect.top + 18 });
  await pointer({ action: "move", x: rect.left + 18, y: rect.top - 22 });
  await pointer({ action: "up" });
  expect(param.value).toBeGreaterThan(1000);
  expect(first.valueAsNumber).toBe(param.value);
  param.value = 1200;
  expect(first.valueAsNumber).toBe(1200);
  expect(second.valueAsNumber).toBe(1200);
  expect(dial.getAttribute("aria-valuenow")).toBe("1200");
});

test("the mono meter reports float overs and stops reading when detached", async () => {
  let reads = 0;
  const meter = mountLevelMeter(host(), {
    source: {
      sampleCount: 4,
      read: (samples) => {
        reads++;
        samples.set([1.25, 0, -0.5, 0]);
      },
    },
  });
  own(() => meter.dispose());
  expect(meter.getLevel()).toEqual({ peak: 1.25, rms: Math.sqrt((1.25 ** 2 + 0.5 ** 2) / 4) });
  meter.dispose();
  const before = reads;
  await new Promise(requestAnimationFrame);
  expect(reads).toBe(before);
  expect(meter.element.isConnected).toBe(false);
});

test("widgets create their elements in the mount root's own document", () => {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  own(() => frame.remove());
  const doc = frame.contentDocument!;
  const root = doc.createElement("div");
  doc.body.append(root);
  const param = new Param({ default: 0.5, min: 0, max: 1 });
  own(() => param.dispose());
  vi.spyOn(document, "createElement").mockImplementation(() => {
    throw new Error("created an element in the global document");
  });
  const slider = mountParameter(root, { param });
  const knob = mountParameter(root, { param, orientation: "rotary" });
  const meter = mountLevelMeter(root, { source: { sampleCount: 4, read: () => undefined } });
  vi.restoreAllMocks();
  for (const handle of [slider, knob, meter]) own(() => handle.dispose());
  for (const element of [slider.element, knob.element, ...root.querySelectorAll("meter, span, input")]) {
    expect(element.ownerDocument).toBe(doc);
  }
});
