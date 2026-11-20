import { effect, untracked } from "@audiorective/core";
import type { Clip, ClipLauncher, Quantize } from "@audiorective/launcher";
import { mountClipGrid, type ClipGridLayout } from "@audiorective/widgets";
import type { Workspace } from "@audiorective/daw";

export function mountStudioSession(
  root: HTMLElement,
  workspace: Workspace,
  options: {
    quantize(): Quantize;
    /** Whether session clips loop (false: each plays once and returns the track to Arrangement). */
    loop(): boolean;
    report(error: unknown): void;
  },
) {
  let request = 0;
  let grid: ReturnType<typeof mountClipGrid> | undefined;
  let mounted: ClipLauncher | undefined;
  const labels = {
    scene: "場景",
    cancel: "取消排隊",
    arrangement: "回到編曲",
    idle: "編曲模式",
    playing: "片段播放中",
    empty: "匯入音訊片段即可在這裡觸發。",
    queued: (beat: number) => `等待第 ${Number((beat + 1).toFixed(3))} 拍`,
  };
  const mount = (launcher: ClipLauncher) => {
    grid?.destroy();
    mounted = launcher;
    grid = mountClipGrid(root, {
      launcher,
      labels,
      cancel: () => {
        request++;
        launcher.cancelQueued();
      },
      launch(command) {
        const generation = request; // only cancel and destroy invalidate an in-flight launch; independent clicks coexist
        const run = async () => {
          await workspace.flush();
          if (generation !== request) return;
          if (workspace.clock.state.value !== "playing") await workspace.play();
          if (generation !== request || workspace.clock.state.value !== "playing") return;
          const current = workspace.session.value;
          current.quantize.value = options.quantize();
          for (const track of Object.values(current.tracks))
            for (const clip of track.clips) if (clip && clip.options.value.loop !== options.loop()) clip.configure({ loop: options.loop() });
          command();
        };
        void run().catch(options.report);
      },
    });
    layoutKey = "";
  };
  let layoutKey = "";
  const identities = new WeakMap<object, number>();
  let identityCount = 0;
  const identity = (item: object) => {
    if (!identities.has(item)) identities.set(item, ++identityCount);
    return identities.get(item);
  };
  const stopLayout = effect(() => {
    const launcher = workspace.session.value;
    workspace.project.cells.revision.$();
    const { tracks, markers } = workspace.project;
    const sceneTracks: ClipGridLayout["tracks"][number][] = [];
    type SceneSlots = ClipGridLayout["scenes"][number]["clips"][number][];
    const clipsByTime = new Map<number, SceneSlots[]>();
    for (const track of tracks) {
      const sessionTrack = launcher.tracks[track.id];
      if (track.kind !== "audio" || !sessionTrack) continue;
      const launchable = track.clips.filter((clip) => clip.kind === "audio" && !clip.media);
      if (!launchable.length) continue;
      sceneTracks.push({ track: sessionTrack, label: track.name });
      for (const clip of launchable) {
        const sessionClip: Clip | null = workspace.sessionClip(track.id, clip.id);
        if (!sessionClip) continue;
        let groups = clipsByTime.get(clip.time);
        if (!groups) clipsByTime.set(clip.time, (groups = []));
        let group = groups.find((slots) => slots.every((slot) => slot.track !== sessionTrack));
        if (!group) groups.push((group = []));
        group.push({ track: sessionTrack, clip: sessionClip, label: `▶ ${clip.duration.toFixed(2)} s` });
      }
    }
    const scenes = [...clipsByTime.entries()]
      .sort(([left], [right]) => left - right)
      .flatMap(([time, groups]) => {
        const label = markers.find((marker) => marker.time === time)?.name || `${time.toFixed(2)} s`;
        return groups.map((clips, index) => ({ label: index ? `${label} · ${index + 1}` : label, clips }));
      });
    const layout = { tracks: sceneTracks, scenes };
    const key = JSON.stringify([
      identity(launcher),
      sceneTracks.map(({ track, label }) => [identity(track), label]),
      scenes.map((scene) => [scene.label, scene.clips.map((slot) => [identity(slot.track), identity(slot.clip), slot.label])]),
    ]);
    untracked(() => {
      if (launcher !== mounted) mount(launcher);
      if (key !== layoutKey) {
        grid!.setLayout(layout);
        layoutKey = key;
      }
    });
  });
  return {
    destroy() {
      request++;
      stopLayout();
      grid?.destroy();
    },
  };
}
