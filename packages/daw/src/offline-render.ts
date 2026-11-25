import { ManualTickSource } from "@audiorective/clock";
import type { Project } from "./model";
import { Workspace } from "./runtime";

const RENDER_QUANTUM = 128;
const TICK_INTERVAL = 0.025;

/** Abort handling shared by the offline mix renders: `hold` makes any wait reject the moment the signal aborts. */
export class RenderControl {
  private readonly interrupted: Promise<never>;
  private readonly cancel: () => void;

  constructor(
    readonly name: string,
    readonly signal?: AbortSignal,
  ) {
    let interrupt!: (error: unknown) => void;
    this.interrupted = new Promise<never>((_, reject) => (interrupt = reject));
    this.interrupted.catch(() => undefined);
    this.cancel = () => interrupt(new DOMException(`${name} was cancelled.`, "AbortError"));
    signal?.addEventListener("abort", this.cancel, { once: true });
  }

  readonly checkAbort = (): void => {
    if (this.signal?.aborted) throw new DOMException(`${this.name} was cancelled.`, "AbortError");
  };

  hold = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, this.interrupted]);

  dispose(): void {
    this.signal?.removeEventListener("abort", this.cancel);
  }
}

/** Render `frameCount` stereo frames of `snapshot` from frame `from`, on a fresh OfflineAudioContext with the live workspace's devices. */
export async function renderSnapshotFrames(
  workspace: Workspace,
  snapshot: Project,
  control: RenderControl,
  from: number,
  frameCount: number,
): Promise<Float32Array[]> {
  const { hold, checkAbort, name } = control;
  const { signal } = control;
  const sampleRate = workspace.context.sampleRate;
  const context = new OfflineAudioContext(2, frameCount, sampleRate);
  const ticks = new ManualTickSource();
  let render: Workspace | undefined;
  let rendering: Promise<AudioBuffer> | undefined;
  try {
    const creating = Workspace.create(context as unknown as AudioContext, snapshot, {
      ...workspace.deviceOptions,
      destination: context.destination,
      tickSource: ticks,
    });
    creating.then((created) => (signal?.aborted ? created.dispose() : undefined)).catch(() => undefined);
    render = await hold(creating);
    if (render.warnings.length) throw new Error(`${name} has unresolved devices: ${render.warnings.join(" ")}`);
    render.seek(from / sampleRate);
    await hold(render.play());
    ticks.tick();
    await hold(render.renderSettled());
    let tickIndex = 1;
    let previous = 0;
    const nextStop = (): number | undefined => {
      previous = Math.max(Math.ceil((tickIndex++ * TICK_INTERVAL * sampleRate) / RENDER_QUANTUM) * RENDER_QUANTUM, previous + RENDER_QUANTUM);
      return previous < frameCount ? previous : undefined;
    };
    const suspendAt = (frame: number) => context.suspend((frame - RENDER_QUANTUM / 2) / sampleRate);
    let stop = nextStop();
    let suspended = stop === undefined ? undefined : suspendAt(stop);
    suspended?.catch(() => undefined);
    rendering = context.startRendering();
    void rendering.catch(() => undefined);
    while (stop !== undefined && suspended) {
      await hold(Promise.race([suspended, rendering]));
      checkAbort();
      ticks.tick();
      await hold(render.renderSettled());
      stop = nextStop();
      suspended = stop === undefined ? undefined : suspendAt(stop);
      suspended?.catch(() => undefined);
      await context.resume();
    }
    const buffer = await hold(rendering);
    checkAbort();
    return [buffer.getChannelData(0), buffer.getChannelData(1)];
  } finally {
    render?.dispose();
    if (rendering && context.state === "suspended") await context.resume().catch(() => undefined);
  }
}
