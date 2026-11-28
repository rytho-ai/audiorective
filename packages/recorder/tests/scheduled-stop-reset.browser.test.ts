import { expect, test } from "vitest";
import { Clock } from "@audiorective/clock";
import { AudioRecorder } from "../src/AudioRecorder";

const cases = [false, true].flatMap((streaming) => [
  ...["stop", "pause", "seek", "detach"].map((action) => ({ mode: streaming ? "stream" : "buffered", streaming, action, preloaded: true })),
  { mode: streaming ? "stream" : "buffered", streaming, action: "stop", preloaded: false },
]);

test.each(cases)("$action cancels an unstarted $mode take with a scheduled Stop (preloaded=$preloaded)", async ({ streaming, action, preloaded }) => {
  const context = new AudioContext();
  const clock = new Clock({ context });
  const recorder = new AudioRecorder(context, { channels: 1 });
  const detach = clock.attach(recorder);
  let writes = 0;
  try {
    await context.resume();
    if (preloaded) await recorder.ready;
    clock.start();
    const when = context.currentTime + 0.15;
    const take = streaming
      ? recorder.record({
          when,
          onChunk: () => {
            writes++;
          },
        })
      : recorder.record({ when });
    const stopped = streaming ? recorder.stop({ result: "span", when: when + 0.1 }) : recorder.stop({ when: when + 0.1 });
    void take.catch(() => {});
    void stopped.catch(() => {});
    if (action === "stop") clock.stop();
    else if (action === "pause") clock.pause();
    else if (action === "seek") clock.seek(2);
    else detach();
    await expect(take).rejects.toMatchObject({ name: "AbortError" });
    await expect(stopped).rejects.toMatchObject({ name: "AbortError" });
    expect(writes).toBe(0);
    expect(recorder.cells.state.value).toBe("idle");
    expect(recorder.cells.startedAt.value).toBeNull();
  } finally {
    recorder.dispose();
    clock.dispose();
    await context.close();
  }
});
