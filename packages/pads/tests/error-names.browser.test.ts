import { expect, test } from "vitest";
import { PadBank } from "../src/PadBank";

test.each(["empty", "duplicate"])("pad ID shape uses TypeError: %s", (kind) => {
  const context = new OfflineAudioContext(1, 128, 48000);
  const pads =
    kind === "empty"
      ? [{ id: "", sound: "C4" }]
      : [
          { id: "one", sound: "C4" },
          { id: "one", sound: "D4" },
        ];
  expect(() => new PadBank(context, pads)).toThrowError(expect.objectContaining({ name: "TypeError" }));
});

test.each(["route", "assign"])("unknown pad uses RangeError: %s", (command) => {
  const context = new OfflineAudioContext(1, 128, 48000);
  const bank = new PadBank(context, [{ id: "one", sound: "C4" }]);
  try {
    const attempt = () => (command === "route" ? bank.routePad("missing", null) : bank.assign("missing", "C4"));
    expect(attempt).toThrowError(expect.objectContaining({ name: "RangeError" }));
  } finally {
    bank.dispose();
  }
});

test("disposed pad bank uses InvalidStateError", () => {
  const context = new OfflineAudioContext(1, 128, 48000);
  const bank = new PadBank(context, [{ id: "one", sound: "C4" }]);
  bank.dispose();
  expect(() => bank.trigger("one")).toThrowError(expect.objectContaining({ name: "InvalidStateError" }));
});
