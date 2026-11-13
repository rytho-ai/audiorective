/** Source I/O behind RangePlayer's loading lifecycle; no playback or view state. */
export type RangeLoadProgress =
  | Readonly<{ phase: "download" | "read"; loadedBytes: number; totalBytes: number | null }>
  | Readonly<{ phase: "decode" }>
  | Readonly<{ phase: "peaks" }>;

/** A source adapter may borrow a shared decode cache. Respect the signal for this
 * consumer; shared work may continue. The block discards stale progress/results. */
export type RangeSourceLoader = (
  url: string,
  options: {
    context: AudioContext;
    signal: AbortSignal;
    onProgress: (progress: Exclude<RangeLoadProgress, { phase: "peaks" }>) => void;
  },
) => Promise<AudioBuffer>;

async function readStream(
  stream: ReadableStream<Uint8Array>,
  total: number | null,
  signal: AbortSignal,
  report: (loaded: number) => void,
): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  let loaded = 0;
  try {
    signal.throwIfAborted();
    const target = total === null ? null : new Uint8Array(total);
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (target) {
        if (loaded + value.length > target.length) throw new Error("Audio download size does not match Content-Length.");
        target.set(value, loaded);
      } else chunks.push(value);
      loaded += value.length;
      report(loaded);
    }
    if (total !== null && loaded !== total) throw new Error("Audio download size does not match Content-Length.");
    if (target) return target.buffer;
    const merged = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return merged.buffer;
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export const loadSource = async (source: string | File, { context, signal, onProgress }: Parameters<RangeSourceLoader>[1]): Promise<AudioBuffer> => {
  let bytes: ArrayBuffer;
  if (typeof source === "string") {
    if (!source.trim()) throw new Error("Enter an audio URL.");
    onProgress({ phase: "download", loadedBytes: 0, totalBytes: null });
    const response = await fetch(source, { signal });
    signal.throwIfAborted();
    if (!response.ok) throw new Error(`Audio request failed: HTTP ${response.status}.`);
    if (response.headers.get("content-type")?.startsWith("text/")) throw new Error("Audio request returned text instead of audio.");
    const length = response.headers.get("content-length");
    const encoded = response.headers.get("content-encoding");
    const parsed = length !== null && /^\d+$/.test(length) ? Number(length) : NaN;
    const total = (!encoded || encoded === "identity") && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
    const report = (loadedBytes: number) => onProgress({ phase: "download", loadedBytes, totalBytes: total });
    report(0);
    if (response.body) bytes = await readStream(response.body, total, signal, report);
    else {
      bytes = await response.arrayBuffer();
      signal.throwIfAborted();
      if (total !== null && bytes.byteLength !== total) throw new Error("Audio download size does not match Content-Length.");
      report(bytes.byteLength);
    }
  } else {
    const report = (loadedBytes: number) => onProgress({ phase: "read", loadedBytes, totalBytes: source.size });
    report(0);
    bytes = await readStream(source.stream(), source.size, signal, report);
  }
  signal.throwIfAborted();
  onProgress({ phase: "decode" });
  const buffer = await context.decodeAudioData(bytes);
  signal.throwIfAborted();
  return buffer;
};
