import type { WebClapHost } from "@audiorective/host/webclap";
import type { DeviceParameterRecord } from "./device-parameters";

/**
 * The two-way tie between one running plug-in and its device's parameter table in the Project. The table is the authority: `apply` writes the song's values into the plug-in,
 * and a value the plug-in moves by itself (its own automation, the person turning its GUI) is reported to `onChange` once per microtask so the Workspace can keep the table equal
 * to what the plug-in reports. A value the link wrote is never reported back.
 */
export class DeviceParameterLink {
  /** The last value known to be equal on both sides, by parameter ID. */
  private readonly applied = new Map<string, number>();
  private readonly stops: Array<() => void> = [];
  private readonly moved = new Map<string, number>();
  private stopped = false;

  constructor(
    private readonly host: WebClapHost,
    private readonly onChange: (moved: ReadonlyMap<string, number>) => void,
  ) {
    for (const info of host.parameterInfo) {
      const id = String(info.id);
      const param = host.param(info.id);
      if (!param) continue;
      this.applied.set(id, param.value);
      this.stops.push(param.subscribe((value) => this.report(id, value)));
    }
  }

  /**
   * Writes every value of `table` the plug-in does not already hold (all of them with `force`, for after the plug-in loaded other state). Returns how many it wrote.
   * A parameter the plug-in does not have is skipped.
   */
  apply(table: readonly DeviceParameterRecord[], force = false): number {
    let written = 0;
    for (const record of table) {
      const param = this.host.param(record.id);
      if (!param) continue;
      if (!force && this.applied.get(record.id) === record.value) continue;
      this.applied.set(record.id, record.value);
      this.moved.delete(record.id);
      param.value = record.value;
      written++;
    }
    return written;
  }

  /** Stops reporting. The link does not touch the plug-in again. */
  dispose(): void {
    this.stopped = true;
    for (const stop of this.stops.splice(0)) stop();
    this.moved.clear();
  }

  private report(id: string, value: number): void {
    if (this.stopped || this.applied.get(id) === value) return;
    this.applied.set(id, value);
    const first = !this.moved.size;
    this.moved.set(id, value);
    if (first)
      queueMicrotask(() => {
        const moved = new Map(this.moved);
        this.moved.clear();
        if (!this.stopped && moved.size) this.onChange(moved);
      });
  }
}
