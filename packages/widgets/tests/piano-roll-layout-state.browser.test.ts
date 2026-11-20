/** Custom controls must read the same snap state that note/selection gestures use. */
import { expect, test, vi, afterEach } from "vitest";
import { MidiSequence } from "@audiorective/midi";
import { mountPianoRoll, type PianoRollControls, type PianoRollLayoutFrame } from "../src/piano-roll";
import { host, own, cleanup } from "./helpers";

afterEach(cleanup);

test("custom layout reads initial snap and follows caller and layout control writes", () => {
  const model = new MidiSequence({ duration: 4, notes: [] });
  own(() => model.dispose());
  const output = document.createElement("output");
  let controls!: PianoRollControls;
  const view = mountPianoRoll(host(), {
    model,
    snap: "beat",
    layout(root, viewport, actions) {
      controls = actions;
      root.append(output, viewport);
      return {
        render(frame: PianoRollLayoutFrame) {
          output.textContent = frame.snap;
        },
      };
    },
  });
  own(() => view.dispose());
  expect(output.textContent).toBe("beat");
  view.setSnap("downbeat");
  expect(output.textContent).toBe("downbeat");
  controls.setSnap("off");
  expect(output.textContent).toBe("off");
});

test("default snap is off and a disposed view cannot render a snap update", () => {
  const model = new MidiSequence({ duration: 4, notes: [] });
  own(() => model.dispose());
  const render = vi.fn();
  const view = mountPianoRoll(host(), {
    model,
    layout(root, viewport) {
      root.append(viewport);
      return { render };
    },
  });
  own(() => view.dispose());
  expect(render.mock.lastCall![0].snap).toBe("off");
  view.dispose();
  const count = render.mock.calls.length;
  view.setSnap("beat");
  expect(render).toHaveBeenCalledTimes(count);
});
