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
/** Non-observable bookkeeping for a row. Everything a reader can see lives in `state`. */
type Job = { resource?: Resource; finish(id: string | null): void };

const empty = Object.freeze({ rows: Object.freeze([]), decodedBytes: 0, previewId: null, previewPlaying: false });

/** A sequential File decoder and independent audition player. The caller owns the audio context. */
export class SampleLibrary {
  readonly output: GainNode;
  private readonly source = cell<SampleLibraryState>(empty);
  readonly state = readonlyCell(this.source);
  private readonly jobs = new Map<string, Job>();
  private readonly resources = new Map<string, Resource>();
  private readonly queue: { id: string; file: File }[] = [];
  private readonly maxFileBytes: number;
  private readonly maxDecodedBytes: number;
  private nextId = 0;
  private working = false;
  private destroyed = false;
  private previewVoice?: { id: string; player: BufferPlayer; lease: SampleLease; unsubscribe(): void };

  private get snapshot(): SampleLibraryState {
    return untracked(() => this.source.value);
  }

  /** Commit a change to the observable state. */
  private patch(change: Partial<SampleLibraryState>): void {
    this.source.value = Object.freeze({ ...this.snapshot, ...change });
  }

  private setRow(row: SampleRow): void {
    const rows = this.snapshot.rows;
    const index = rows.findIndex(({ id }) => id === row.id);
    this.patch({ rows: Object.freeze(index === -1 ? [...rows, Object.freeze(row)] : rows.map((r, i) => (i === index ? Object.freeze(row) : r))) });
  }

  private dropRow(id: string): void {
    this.patch({ rows: Object.freeze(this.snapshot.rows.filter((row) => row.id !== id)) });
  }

  private fail(id: string, name: string, error: string): void {
    this.setRow({ id, name, status: "error", error });
  }

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
    const results: Promise<string | null>[] = [];
    batch(() => {
      for (const file of files)
        results.push(
          new Promise<string | null>((finish) => {
            const id = `sample-${++this.nextId}`;
            this.jobs.set(id, { finish });
            if (file.size > this.maxFileBytes) {
              this.fail(id, file.name, "File byte limit exceeded.");
              finish(id);
            } else {
              this.setRow({ id, name: file.name, status: "loading" });
              this.queue.push({ id, file });
            }
          }),
        );
    });
    void this.decode();
    return Promise.all(results);
  }

  private async decode(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      while (!this.destroyed && this.queue.length) {
        const { id, file } = this.queue.shift()!;
        try {
          const data = await file.arrayBuffer();
          if (!this.jobs.has(id)) continue;
          const digest = await globalThis.crypto?.subtle?.digest("SHA-256", data);
          const hash = digest && Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
          if (!this.jobs.has(id)) continue;
          const job = this.jobs.get(id)!;
          const existing = hash ? this.resources.get(hash) : undefined;
          if (existing) {
            const owner = [...this.jobs].find(([, candidate]) => candidate.resource === existing);
            if (owner) {
              this.jobs.delete(id);
              this.dropRow(id);
              job.finish(owner[0]);
              continue;
            }
            existing.owners++;
            job.resource = existing;
          } else {
            const buffer = await this.context.decodeAudioData(data);
            if (!this.jobs.has(id)) continue;
            const bytes = buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
            if (bytes > this.maxDecodedBytes - this.snapshot.decodedBytes) throw new Error("Decoded PCM budget exceeded.");
            const resource = { buffer, bytes, hash, owners: 1 };
            if (hash) this.resources.set(hash, resource);
            job.resource = resource;
            batch(() => {
              this.patch({ decodedBytes: this.snapshot.decodedBytes + bytes });
              this.setRow({ id, name: file.name, status: "ready", duration: buffer.duration });
            });
            job.finish(id);
            continue;
          }
          this.setRow({ id, name: file.name, status: "ready", duration: job.resource.buffer.duration });
          job.finish(id);
        } catch (error) {
          const job = this.jobs.get(id);
          if (job) {
            this.fail(id, file.name, error instanceof Error ? error.message : String(error));
            job.finish(id);
          }
        }
      }
    } finally {
      this.working = false;
    }
  }

  /** Borrow decoded PCM until release, including after its browser row has been removed. */
  acquire(id: string): SampleLease {
    this.assertAlive();
    const resource = this.jobs.get(id)?.resource;
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
      },
    };
  }

  remove(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    batch(() => {
      this.jobs.delete(id);
      const queued = this.queue.findIndex((item) => item.id === id);
      if (queued !== -1) this.queue.splice(queued, 1);
      if (this.previewVoice?.id === id) this.stopPreview();
      this.dropRow(id);
      if (job.resource) this.release(job.resource);
      job.finish(null);
    });
  }

  async preview(id: string): Promise<void> {
    const lease = this.acquire(id);
    this.stopPreview();
    let player: BufferPlayer | undefined;
    try {
      player = untracked(() => new BufferPlayer(this.context, { buffer: lease.buffer }));
      player.output.connect(this.output);
    } catch (error) {
      player?.destroy();
      lease.release();
      throw error;
    }
    const voice = {
      id,
      player,
      lease,
      // Detached from any effect that called `preview`, which would otherwise dispose this on its next run.
      unsubscribe: untracked(() =>
        effect(() => {
          const playing = player.cells.isPlaying.value;
          if (this.previewVoice?.player === player) untracked(() => this.patch({ previewPlaying: playing }));
        }),
      ),
    };
    this.previewVoice = voice;
    batch(() => this.patch({ previewId: id }));
    try {
      player.start();
    } catch (error) {
      this.stopPreview();
      throw error;
    }
  }

  stopPreview(): void {
    const voice = this.previewVoice;
    if (!voice) return;
    this.previewVoice = undefined;
    batch(() => {
      voice.unsubscribe();
      voice.player.destroy();
      voice.lease.release();
      this.patch({ previewId: null, previewPlaying: false });
    });
  }

  private release(resource: Resource): void {
    if (--resource.owners !== 0) return;
    this.patch({ decodedBytes: this.snapshot.decodedBytes - resource.bytes });
    if (resource.hash) this.resources.delete(resource.hash);
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error("Sample Library is destroyed.");
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    batch(() => {
      this.stopPreview();
      for (const id of [...this.jobs.keys()]) this.remove(id);
    });
    this.output.disconnect();
  }
}
