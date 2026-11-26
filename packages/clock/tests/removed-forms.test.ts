import { expect, test } from "vitest";
import { Clock, ManualTickSource } from "../src";

// `start(when, offsetBeats)` is the only start form: the options object `{ atBeat }` was removed. The ts-expect-error lines fail
// `pnpm typecheck` if it is accepted again; the runtime check shows the positional form still places the first beat.
test("clock.start takes positional (when, offsetBeats), not { atBeat }", () => {
  const context = { currentTime: 0 };
  const clock = new Clock({ context, tickSource: new ManualTickSource(), bpm: 120 });
  try {
    // @ts-expect-error `atBeat` was removed; pass `offsetBeats` as the second argument.
    const gone: () => void = () => clock.start({ atBeat: 4 });
    void gone;
    clock.start(0.5, 4);
    expect(clock.state.value).toBe("playing");
    expect(clock.beat).toBe(4);
  } finally {
    clock.dispose();
  }
});
