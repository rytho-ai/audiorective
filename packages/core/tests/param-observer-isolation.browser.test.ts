import { expect, test } from "vitest";
import { SchedulableParam } from "../src";

const frames = async () => {
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
};

test("a failed observer is reported without freezing other native parameter readback", async () => {
  const context = new AudioContext();
  const first = new GainNode(context);
  const second = new GainNode(context);
  const bad = new SchedulableParam({ default: 0, audioContext: context, audioParam: first.gain, syncInterval: 0 });
  const good = new SchedulableParam({ default: 0, audioContext: context, audioParam: second.gain, syncInterval: 0 });
  const failure = new Error("observer failed");
  const reported: unknown[] = [];
  const observed: number[] = [];
  const stopGood = good.subscribe((value) => observed.push(value));
  const onError = (event: ErrorEvent) => {
    if (event.error !== failure) return;
    reported.push(event.error);
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  window.addEventListener("error", onError, true);
  let thrown = false;
  const stop = bad.subscribe(() => {
    if (!thrown) {
      thrown = true;
      throw failure;
    }
  });
  try {
    first.gain.value = 0.5;
    second.gain.value = 0.25;
    await frames();
    expect(thrown).toBe(true);
    expect(reported).toEqual([failure]);
    expect(good.value).toBe(0.25);
    expect(observed).toEqual([0.25]);
    second.gain.value = 0.75;
    await frames();
    expect(good.value).toBe(0.75);
    expect(observed).toEqual([0.25, 0.75]);
  } finally {
    stop();
    stopGood();
    bad.dispose();
    good.dispose();
    window.removeEventListener("error", onError, true);
    await context.close();
  }
});
