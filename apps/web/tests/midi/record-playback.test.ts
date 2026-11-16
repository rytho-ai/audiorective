import { expect, test, vi } from "vitest";
import { compileMidiPlaybackEvents } from "@audiorective/blocks/midi";
import { mountMidiApp } from "../../src/demos/midi/app";
import { planMidiVoices, type PlannedVoice } from "../../src/demos/midi/voice-plan";

test("the showroom records, edits and auditions one take with its pedal messages", async () => {
  const previous = Object.getOwnPropertyDescriptor(navigator, "requestMIDIAccess");
  const input = Object.assign(new EventTarget(), {
    id: "keyboard",
    name: "Test keyboard",
    state: "connected",
    open: async () => input,
    close: vi.fn(async () => input),
  });
  const access = Object.assign(new EventTarget(), { inputs: new Map([[input.id, input]]) });
  Object.defineProperty(navigator, "requestMIDIAccess", { configurable: true, value: async () => access });
  const pair = { contextTime: 10, performanceTime: 1000 };
  const context = { state: "running", currentTime: 10, resume: async () => {}, getOutputTimestamp: () => ({ ...pair }) };
  const now = vi.spyOn(performance, "now").mockReturnValue(1000);
  const root = document.createElement("div");
  document.body.append(root);
  let heard: readonly PlannedVoice[] = [];
  const app = mountMidiApp(root, {
    context: context as unknown as AudioContext,
    output: {} as AudioNode,
    makeAuditioner: (read) => ({
      async play() {
        const state = read();
        heard = planMidiVoices(compileMidiPlaybackEvents(state.source ?? { startTime: 0, events: [] }, state), state.duration);
      },
      pause() {},
      seek() {},
      get position() {
        return 0;
      },
      get isPlaying() {
        return false;
      },
      destroy() {},
    }),
  });
  try {
    const click = (name: string) => root.querySelector<HTMLButtonElement>(`[data-control="${name}"]`)!.click();
    click("midi-access");
    await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('[data-control="record"]')?.disabled).toBe(false));
    click("record");
    await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('[data-control="stop-record"]')?.disabled).toBe(false));
    function emit(data: number[], at: number) {
      const event = new Event("midimessage");
      Object.defineProperties(event, { data: { value: new Uint8Array(data) }, timeStamp: { value: 1000 + at * 1000 } });
      input.dispatchEvent(event);
    }
    emit([0x90, 60, 90], 0);
    emit([0xb0, 64, 127], 0.02);
    emit([0x80, 60, 0], 0.03);
    emit([0xb0, 64, 0], 0.06);
    pair.contextTime = 10.1;
    pair.performanceTime = 1100;
    now.mockReturnValue(1100);
    click("stop-record");
    expect(app.getState().notes).toHaveLength(1);
    app.editNote(app.getState().notes[0].id, { pitch: 62 });
    await app.play();
    expect(heard).toMatchObject([{ pitch: 62, start: 0, end: 0.06, velocity: 90 }]);
    expect(root.querySelector('[data-control="status"]')?.textContent).toContain("Edit, then Play");
  } finally {
    app.destroy();
    expect(input.close).toHaveBeenCalled();
    root.remove();
    if (previous) Object.defineProperty(navigator, "requestMIDIAccess", previous);
    else Reflect.deleteProperty(navigator, "requestMIDIAccess");
    vi.restoreAllMocks();
  }
});
