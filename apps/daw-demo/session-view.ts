import { effect, untracked } from "@audiorective/core";
import type { Clip, ClipLauncher, Quantize } from "@audiorective/launcher";
import { mountClipGrid, type ClipGridLayout } from "@audiorective/widgets";
import { sessionFor, type Workspace } from "@audiorective/daw";

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
    grid?.dispose();
    mounted = launcher;
    grid = mountClipGrid(root, {
      launcher,
      labels,
      cancel: () => {
        request++;
        launcher.cancelQueued();
      },
      launch(command) {
        const generation = request; // only cancel and dispose invalidate an in-flight launch; independent clicks coexist
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
    const song = sessionFor(workspace.project);
    type SceneSlots = ClipGridLayout["scenes"][number]["clips"][number][];
    const scenes = song.scenes.map(({ name }, index) => ({ label: name, index, clips: [] as SceneSlots }));
    const sceneTracks: ClipGridLayout["tracks"][number][] = [];
    for (const track of workspace.project.tracks) {
      const sessionTrack = launcher.tracks[track.id];
      if (track.kind !== "audio" || !sessionTrack) continue;
      const slots = song.scenes.map((scene) => song.clipAt({ trackId: track.id, sceneId: scene.id }));
      if (!slots.some((clip) => clip?.kind === "audio" && !clip.media)) continue;
      sceneTracks.push({ track: sessionTrack, label: track.name });
      slots.forEach((clip, index) => {
        if (clip?.kind !== "audio" || clip.media) return;
        const sessionClip: Clip | null = workspace.sessionClip(track.id, clip.id);
        if (sessionClip) scenes[index].clips.push({ track: sessionTrack, clip: sessionClip, label: `▶ ${clip.duration.toFixed(2)} s` });
      });
    }
    const layout = { tracks: sceneTracks, scenes };
    const key = JSON.stringify([
      identity(launcher),
      sceneTracks.map(({ track, label }) => [identity(track), label]),
      scenes.map((scene) => [scene.label, scene.index, scene.clips.map((slot) => [identity(slot.track), identity(slot.clip), slot.label])]),
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
    dispose() {
      request++;
      stopLayout();
      grid?.dispose();
    },
  };
}
