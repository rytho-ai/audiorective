import { WebClapHost } from "@audiorective/host/webclap";
import { afterEach, describe, expect, test } from "vitest";

const worklet = "/@fs" + new URL("../../host/dist/webclap-worklet.js", import.meta.url).pathname.replace(/^\/@fs/, "");
const bundle = "/@fs" + new URL("../../../apps/daw-demo/public/plugin/oxo-synth2.wclap", import.meta.url).pathname.replace(/^\/@fs/, "");
const pluginId = "com.oxo.music.oxosynth2";
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function open(context: AudioContext) {
  const host = await WebClapHost.load(context, { url: bundle, pluginId, workletUrl: worklet });
  cleanups.push(() => host.dispose());
  return host;
}

describe("WebCLAP save on a context that is not running", () => {
  test.each(["suspended", "running", "offline"] as const)("a parameter written before saveState survives a reload (%s context)", async (mode) => {
    const context = (mode === "offline" ? new OfflineAudioContext(2, 48000, 48000) : new AudioContext()) as unknown as AudioContext;
    if (mode !== "offline") cleanups.push(() => context.close());
    if (mode === "suspended") await context.suspend();
    else if (mode === "running") await context.resume();
    const host = await open(context);
    expect(context.state).toBe(mode === "running" ? "running" : "suspended");
    const id = "5";
    const before = host.params[id as `${number}`].value;
    const target = before === 12 ? 30 : 12;
    host.params[id as `${number}`].value = target;
    const bytes = await host.saveState();
    expect(context.state).toBe(mode === "running" ? "running" : "suspended");

    const reopened = await open(
      mode === "suspended" ? await suspended() : mode === "offline" ? (new OfflineAudioContext(2, 48000, 48000) as unknown as AudioContext) : context,
    );
    await reopened.loadState(bytes);
    expect(reopened.params[id as `${number}`].value).toBe(target);
  });
});

async function suspended() {
  const context = new AudioContext();
  cleanups.push(() => context.close());
  await context.suspend();
  return context;
}
