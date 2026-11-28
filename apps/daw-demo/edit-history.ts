import type { Project, ProjectEditReceipt, ProjectTrack } from "@audiorective/daw";

type VolumePoints = ProjectTrack["volumeAutomation"];

/** The studio's view of the Project's undo history, shared with any agent editing the same Project. */
export class EditHistory {
  private watched?: Project;
  private stopWatching?: () => void;

  constructor(
    private readonly project: () => Project,
    private readonly changed: () => void,
    private readonly onState: (undo: string | undefined, redo: string | undefined) => void,
  ) {}

  /** Show the history of the Project now in the Workspace. */
  publish(): void {
    const { undo, redo } = this.project().cells.history.value;
    this.onState(undo, redo);
  }

  /** Follow the Workspace's current Project, so edits made outside this view update the buttons too. */
  watch(): void {
    const project = this.project();
    if (project === this.watched) return;
    this.stopWatching?.();
    this.watched = project;
    this.stopWatching = project.cells.history.subscribe(() => this.publish(), { immediate: true });
  }

  recordVolumeAutomation(trackId: string, points: VolumePoints): void {
    this.record("編輯音量自動化", () => this.project().setVolumeAutomation(trackId, points));
  }

  record<T>(label: string, action: () => T): T {
    return this.project().edit(label, action);
  }

  private step(label: string | undefined, run: () => ProjectEditReceipt): string | undefined {
    if (label === undefined) return;
    const receipt = run();
    if (receipt.status !== "applied") throw new Error(receipt.reason);
    this.changed();
    return label;
  }

  undo(): string | undefined {
    const project = this.project();
    return this.step(project.cells.history.value.undo, () => project.undo());
  }

  redo(): string | undefined {
    const project = this.project();
    return this.step(project.cells.history.value.redo, () => project.redo());
  }

  clear(): void {
    this.project().clearHistory();
  }
}
