import { effect, untracked } from "@audiorective/core";
import type { ClipLaunch } from "@audiorective/blocks/launcher";
import { mountClipGrid, type ClipGridLayout } from "@audiorective/widgets";
import type { Workspace } from "@audiorective/daw";

export function mountStudioSession(
  root: HTMLElement,
  workspace: Workspace,
  options: {
    quantum(): number;
    mode(): NonNullable<ClipLaunch["mode"]>;
    report(error: unknown): void;
  },
) {
  let request = 0;
  const grid = mountClipGrid(root, {
    state: workspace.session,
    launch(changes) {
      const generation = ++request;
      const beats = options.quantum();
      const mode = options.mode();
      const launch = async () => {
        await workspace.flush();
        if (generation !== request) return;
        if (workspace.clock.state.value !== "playing") await workspace.play();
        if (generation === request && workspace.clock.state.value === "playing")
          workspace.launchClips(
            changes.map((change) => (change.clipId === null ? change : { ...change, mode })),
            beats,
          );
      };
      void launch().catch(options.report);
    },
    cancel: () => {
      request++;
      workspace.cancelClipLaunch();
    },
    labels: {
      scene: "場景",
      cancel: "取消排隊",
      arrangement: "回到編曲",
      idle: "編曲模式",
      playing: "片段播放中",
      empty: "匯入音訊片段即可在這裡觸發。",
      queued: (beat) => `等待第 ${Number((beat + 1).toFixed(3))} 拍`,
    },
  });
  let layoutKey = "";
  const stopLayout = effect(() => {
    workspace.project.cells.revision.$();
    const { tracks, markers } = workspace.project;
    const sceneTracks: ClipGridLayout["tracks"][number][] = [];
    type SceneSlots = ClipGridLayout["scenes"][number]["clips"][number][];
    const clipsByTime = new Map<number, SceneSlots[]>();
    for (const track of tracks) {
      if (track.kind !== "audio") continue;
      const launchable = track.clips.filter((clip) => clip.kind === "audio" && !clip.media);
      if (!launchable.length) continue;
      sceneTracks.push({ id: track.id, label: track.name });
      for (const clip of launchable) {
        let groups = clipsByTime.get(clip.time);
        if (!groups) clipsByTime.set(clip.time, (groups = []));
        let group = groups.find((slots) => slots.every(({ trackId }) => trackId !== track.id));
        if (!group) groups.push((group = []));
        group.push({ trackId: track.id, clipId: clip.id, label: `▶ ${clip.duration.toFixed(2)} s` });
      }
    }
    const scenes = [...clipsByTime.entries()]
      .sort(([left], [right]) => left - right)
      .flatMap(([time, groups]) => {
        const label = markers.find((marker) => marker.time === time)?.name || `${time.toFixed(2)} s`;
        return groups.map((clips, index) => ({ label: index ? `${label} · ${index + 1}` : label, clips }));
      });
    const layout = { tracks: sceneTracks, scenes };
    const key = JSON.stringify(layout);
    if (key !== layoutKey) {
      untracked(() => grid.setLayout(layout));
      layoutKey = key;
    }
  });
  return {
    destroy() {
      request++;
      stopLayout();
      grid.destroy();
    },
  };
}
