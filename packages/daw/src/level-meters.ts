import { cell, readonlyCell, type ReadonlyCell } from "@audiorective/core";
import type { Channel } from "@audiorective/effects";

/** Post-fader peak in dBFS of the master output and of each track strip; -Infinity when silent. */
export type WorkspaceLevels = Readonly<{ master: number; tracks: Readonly<Record<string, number>> }>;

const SILENT: WorkspaceLevels = Object.freeze({ master: -Infinity, tracks: Object.freeze({}) });

/**
 * Samples the master output with its own analysers and reads each track's `Channel` `cells.level`, once per animation frame, into one cell.
 * The loop starts on the first read, so a Workspace nobody meters (an offline render) never builds analysers.
 */
export class LevelMeters {
  private readonly levels = cell<WorkspaceLevels>(SILENT);
  readonly cell: ReadonlyCell<WorkspaceLevels>;
  private stop?: () => void;
  private disposed = false;

  constructor(
    private readonly context: BaseAudioContext,
    private readonly master: AudioNode,
    private readonly strips: () => Iterable<readonly [string, Pick<Channel, "cells">]>,
  ) {
    this.cell = readonlyCell(() => {
      this.start();
      return this.levels.value;
    });
  }

  private start(): void {
    if (this.stop || this.disposed || typeof requestAnimationFrame !== "function") return;
    const splitter = new ChannelSplitterNode(this.context, { numberOfOutputs: 2 });
    const analysers = [0, 1].map(() => new AnalyserNode(this.context, { fftSize: 2048, smoothingTimeConstant: 0 }));
    this.master.connect(splitter);
    analysers.forEach((analyser, i) => splitter.connect(analyser, i));
    const data = new Float32Array(analysers[0]!.fftSize);
    let frame = 0;
    let stopped = false;
    const tick = () => {
      let peak = 0;
      for (const analyser of analysers) {
        analyser.getFloatTimeDomainData(data);
        for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]!));
      }
      const running = this.context.state === "running";
      const master = running && peak > 0 ? 20 * Math.log10(peak) : -Infinity;
      const previous = this.levels.value;
      const tracks: Record<string, number> = {};
      let same = previous.master === master;
      let count = 0;
      for (const [id, strip] of this.strips()) {
        const level = running ? strip.cells.level.value : -Infinity;
        tracks[id] = level;
        count++;
        if (previous.tracks[id] !== level) same = false;
      }
      if (!same || count !== Object.keys(previous.tracks).length) this.levels.value = Object.freeze({ master, tracks: Object.freeze(tracks) });
      if (!stopped) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    this.stop = () => {
      stopped = true;
      cancelAnimationFrame(frame);
      this.master.disconnect(splitter);
      splitter.disconnect();
      for (const analyser of analysers) analyser.disconnect();
    };
  }

  dispose(): void {
    this.disposed = true;
    this.stop?.();
    this.stop = undefined;
  }
}
