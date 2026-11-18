import { BufferPlayer, batch, cell, effect, readonlyCell, untracked } from "@audiorective/core";

export type SampleRow = Readonly<{
  id: string;
  name: string;
  status: "loading" | "ready" | "error";
  duration?: number;
  error?: string;
}>;
export type SampleLibraryState = Readonly<{
  rows: readonly SampleRow[];
  decodedBytes: number;
  previewId: string | null;
  previewPlaying: boolean;
}>;
export type SampleLease = Readonly<{ buffer: AudioBuffer; release(): void }>;
export type SampleLibraryOptions = { maxFileBytes?: number; maxDecodedBytes?: number };

type Resource = { buffer: AudioBuffer; bytes: number; hash?: string; owners: number };
type Row = { id: string; name: string; resource?: Resource; error?: string; finish(id: string | null): void };

const empty = Object.freeze({ rows: Object.freeze([]), decodedBytes: 0, previewId: null, previewPlaying: false });

/** A sequential File decoder and independent audition player. The caller owns the audio context. */
export class SampleLibrary {
  readonly output: GainNode;
  private readonly source = cell<SampleLibraryState>(empty);
  readonly state = readonlyCell(this.source);
  private readonly rows = new Map<string, Row>();
  private readonly resources = new Map<string, Resource>();
  private readonly queue: { row: Row; file: File }[] = [];
  private readonly maxFileBytes: number;
  private readonly maxDecodedBytes: number;
  private bytes = 0;
  private nextId = 0;
  private working = false;
  private destroyed = false;
  private previewVoice?: { id: string; player: BufferPlayer; lease: SampleLease; unsubscribe(): void };

  constructor(
    private readonly context: AudioContext,
    options: SampleLibraryOptions = {},
  ) {
    this.maxFileBytes = options.maxFileBytes ?? 64 * 1024 * 1024;
    this.maxDecodedBytes = options.maxDecodedBytes ?? 256 * 1024 * 1024;
    if ([this.maxFileBytes, this.maxDecodedBytes].some((limit) => Number.isNaN(limit) || limit < 0))
      throw new RangeError("Sample Library byte limits must be non-negative.");
    this.output = context.createGain();
  }

  /** Load files in order. Duplicate bytes resolve to the current row; a removed job resolves to null. */
  importFiles(files: readonly File[]): Promise<readonly (string | null)[]> {
    this.assertAlive();
    const results = files.map(
      (file) =>
        new Promise<string | null>((finish) => {
          const row: Row = { id: `sample-${++this.nextId}`, name: file.name, finish };
          this.rows.set(row.id, row);
          if (file.size > this.maxFileBytes) {
            row.error = "File byte limit exceeded.";
            finish(row.id);
          } else {
            this.queue.push({ row, file });
          }
        }),
    );
    this.publish();
    void this.decode();
    return Promise.all(results);
  }

  private async decode(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      while (!this.destroyed && this.queue.length) {
        const { row, file } = this.queue.shift()!;
        try {
          const data = await file.arrayBuffer();
          if (!this.rows.has(row.id)) continue;
          const digest = await globalThis.crypto?.subtle?.digest("SHA-256", data);
          const hash = digest && Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
          if (!this.rows.has(row.id)) continue;
          const existing = hash ? this.resources.get(hash) : undefined;
          if (existing) {
            const owner = [...this.rows.values()].find((candidate) => candidate.resource === existing);
            if (owner) {
              this.rows.delete(row.id);
              row.finish(owner.id);
              continue;
            }
            existing.owners++;
            row.resource = existing;
          } else {
            const buffer = await this.context.decodeAudioData(data);
            if (!this.rows.has(row.id)) continue;
            const bytes = buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
            if (bytes > this.maxDecodedBytes - this.bytes) throw new Error("Decoded PCM budget exceeded.");
            const resource = { buffer, bytes, hash, owners: 1 };
            if (hash) this.resources.set(hash, resource);
            row.resource = resource;
            this.bytes += bytes;
          }
          row.finish(row.id);
        } catch (error) {
          if (this.rows.has(row.id)) {
            row.error = error instanceof Error ? error.message : String(error);
            row.finish(row.id);
          }
        } finally {
          this.publish();
        }
      }
    } finally {
      this.working = false;
    }
  }

  /** Borrow decoded PCM until release, including after its browser row has been removed. */
  acquire(id: string): SampleLease {
    this.assertAlive();
    const resource = this.rows.get(id)?.resource;
    if (!resource) throw new Error("Sample Library needs a ready sample.");
    resource.owners++;
    let reference: Resource | undefined = resource;
    return {
      get buffer() {
        if (!reference) throw new Error("Sample lease is released.");
        return reference.buffer;
      },
      release: () => {
        if (!reference) return;
        this.release(reference);
        reference = undefined;
        this.publish();
      },
    };
  }

  remove(id: string): void {
    const row = this.rows.get(id);
    if (!row) return;
    batch(() => {
      this.rows.delete(id);
      const queued = this.queue.findIndex((item) => item.row === row);
      if (queued !== -1) this.queue.splice(queued, 1);
      if (this.previewVoice?.id === id) this.stopPreview();
      if (row.resource) this.release(row.resource);
      row.finish(null);
      this.publish();
    });
  }

  async preview(id: string): Promise<void> {
    const lease = this.acquire(id);
    this.stopPreview();
    const player = new BufferPlayer(this.context, { buffer: lease.buffer });
    player.output.connect(this.output);
    const voice = {
      id,
      player,
      lease,
      unsubscribe: effect(() => {
        void player.cells.isPlaying.value;
        this.publish();
      }),
    };
    this.previewVoice = voice;
    try {
      player.start();
    } catch (error) {
      this.stopPreview();
      throw error;
    }
    this.publish();
  }

  stopPreview(): void {
    const voice = this.previewVoice;
    if (!voice) return;
    this.previewVoice = undefined;
    batch(() => {
      voice.unsubscribe();
      voice.player.destroy();
      voice.lease.release();
    });
  }

  private release(resource: Resource): void {
    if (--resource.owners !== 0) return;
    this.bytes -= resource.bytes;
    if (resource.hash) this.resources.delete(resource.hash);
  }

  private publish(): void {
    this.source.value = Object.freeze({
      rows: Object.freeze(
        [...this.rows.values()].map(
          ({ id, name, error, resource }): SampleRow =>
            Object.freeze({
              id,
              name,
              status: resource ? "ready" : error !== undefined ? "error" : "loading",
              ...(resource ? { duration: resource.buffer.duration } : {}),
              ...(error === undefined ? {} : { error }),
            }),
        ),
      ),
      decodedBytes: this.bytes,
      previewId: this.previewVoice?.id ?? null,
      previewPlaying: untracked(() => this.previewVoice?.player.cells.isPlaying.value) ?? false,
    });
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error("Sample Library is destroyed.");
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    batch(() => {
      this.stopPreview();
      for (const id of this.rows.keys()) this.remove(id);
    });
    this.output.disconnect();
  }
}
