import { expectTypeOf } from "vitest";
import { AudioRecorder, type RecordOptions, type StreamRecordOptions, type RecordedAudio, type RecordedAudioSpan } from "../src/AudioRecorder";

// Compile only; no Web Audio owner is created or called at runtime.
export function recordingContracts(
  recorder: AudioRecorder,
  writer: StreamRecordOptions["onChunk"],
  maybeWriter: StreamRecordOptions["onChunk"] | undefined,
  selector: "span" | undefined,
): void {
  const buffered = recorder.record();
  const bufferedOptions: RecordOptions = { length: 0.1 };
  const typedBuffered = recorder.record(bufferedOptions);
  const spanOptions: StreamRecordOptions = { onChunk: writer, quantize: "1m", length: "2m" };
  const span = recorder.record(spanOptions);
  expectTypeOf(buffered).toEqualTypeOf<Promise<RecordedAudio>>();
  expectTypeOf(typedBuffered).toEqualTypeOf<Promise<RecordedAudio>>();
  expectTypeOf(span).toEqualTypeOf<Promise<RecordedAudioSpan>>();
  expectTypeOf(recorder.stop()).toEqualTypeOf<Promise<RecordedAudio>>();
  expectTypeOf(recorder.stop({ result: "span" })).toEqualTypeOf<Promise<RecordedAudioSpan>>();
  expectTypeOf(recorder.record({ onChunk: maybeWriter })).toEqualTypeOf<Promise<RecordedAudio | RecordedAudioSpan>>();
  expectTypeOf(recorder.stop({ result: selector })).toEqualTypeOf<Promise<RecordedAudio | RecordedAudioSpan>>();
  const badSelector = { when: 1, result: "other" as const };
  // @ts-expect-error Unsupported selectors stay excluded through a variable.
  recorder.stop(badSelector);
  // @ts-expect-error A writer must not be erased into buffered options.
  const erased: RecordOptions = spanOptions;
  void erased;
  // @ts-expect-error Span is PCM-free.
  span.then((value) => value.channels);
  // @ts-expect-error Legacy entry removed without an alias.
  recorder.startStream(writer);
  // @ts-expect-error Legacy stop removed without an alias.
  recorder.stopStream();
  // @ts-expect-error Capture internals remain private.
  recorder.startCapture({});
  // @ts-expect-error Observable lifecycle is written only by the owner.
  recorder.cells.state.value = "armed";
}
