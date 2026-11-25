import { untracked } from "@audiorective/core";
import type { AudioClip, MidiClip, Project, ProjectAudio, ProjectClip, ProjectMidiData } from "./model";
import { sessionBridge, type SessionBridge } from "./model";
import { assertProjectActive, validateXmlText } from "./project-persistence";
import { slotKey, splitSlotKey, type SessionScene, type SessionState } from "./session-state";

export type { SessionScene } from "./session-state";

/** One cell of the Session grid: the scene (row) and the track (column). */
export type SessionSlot = Readonly<{ trackId: string; sceneId: string }>;

const unknownSlot = () => new RangeError("Project session has no scene or track with that id.");
const wrongKind = () => new RangeError("Project session slot clip must match its track kind.");
const emptySlot = () => new RangeError("Project session slot has no clip.");

function sceneName(name: string): string {
  if (typeof name !== "string") throw new TypeError("Project session scene name must be a string.");
  validateXmlText(name);
  if (!name.trim()) throw new RangeError("Project session scene name must not be empty.");
  return name.trim();
}

const sessions = new WeakMap<Project, ProjectSession>();
let createSession: (project: Project) => ProjectSession;

/**
 * The Session grid of one Project: an ordered list of scenes and, for each scene and track, at most one clip that is not on the timeline.
 * It is song content: saved in the file, undoable inside `project.edit` and part of `project.cells.version`.
 * Slot clips are ordinary `ProjectClip`s with `time` 0. Project methods that take a clip ID (`setClipLoop`, `resizeClip`, `setClipName`, `clipName`,
 * `setAudioClipEnvelope`, `setAudioClipGainAutomation`, `applyAudioClipStretch`, `clip.midi.edit`) work on them; timeline methods (`moveClip`, `duplicateClip`, `splitClip`,
 * `removeClip`, `rippleDelete`, `findClips`, `overview` and the `copyRange` and `moveClip` edits) never touch them.
 */
export class ProjectSession {
  private readonly bridge: SessionBridge;

  private constructor(private readonly project: Project) {
    this.bridge = sessionBridge(project);
  }

  static {
    createSession = (project) => new ProjectSession(project);
  }

  /** The scenes in order. Tracked. */
  get scenes(): readonly SessionScene[] {
    return this.bridge.state().scenes;
  }

  /** The clip in a slot, or null when it is empty or the scene or track does not exist. Tracked. */
  clipAt(slot: SessionSlot): ProjectClip | null {
    return this.bridge.state().slots.get(slotKey(slot.sceneId, slot.trackId)) ?? null;
  }

  private position(state: SessionState, sceneId: string): number {
    const index = state.scenes.findIndex((scene) => scene.id === sceneId);
    if (index < 0) throw unknownSlot();
    return index;
  }

  /** The kind of the slot's track; throws when the scene or the track does not exist. */
  private check(state: SessionState, slot: SessionSlot): NonNullable<ReturnType<SessionBridge["trackKind"]>> {
    const kind = this.bridge.trackKind(slot?.trackId);
    if (!kind || !state.scenes.some((scene) => scene.id === slot.sceneId)) throw unknownSlot();
    return kind;
  }

  private withScenes(state: SessionState, scenes: readonly SessionScene[], slots: ReadonlyMap<string, ProjectClip> = state.slots): SessionState {
    return Object.freeze({ scenes: Object.freeze(scenes), slots });
  }

  /** Add an empty scene, at the end or right after `afterSceneId`. The name defaults to "Scene N". */
  addScene(options: { name?: string; afterSceneId?: string } = {}): SessionScene {
    assertProjectActive(this.project);
    return untracked(() => {
      const state = this.bridge.peek();
      const at = options.afterSceneId === undefined ? state.scenes.length : this.position(state, options.afterSceneId) + 1;
      const name = options.name === undefined ? `Scene ${state.scenes.length + 1}` : sceneName(options.name);
      const scene: SessionScene = Object.freeze({ id: this.bridge.newSceneId(), name });
      this.bridge.write(this.withScenes(state, [...state.scenes.slice(0, at), scene, ...state.scenes.slice(at)]));
      return scene;
    });
  }

  renameScene(sceneId: string, name: string): void {
    assertProjectActive(this.project);
    untracked(() => {
      const state = this.bridge.peek();
      const index = this.position(state, sceneId);
      const next = sceneName(name);
      if (state.scenes[index].name === next) return;
      this.bridge.write(
        this.withScenes(
          state,
          state.scenes.map((scene, i) => (i === index ? Object.freeze({ id: scene.id, name: next }) : scene)),
        ),
      );
    });
  }

  /** Remove a scene and every clip in its slots. */
  removeScene(sceneId: string): void {
    assertProjectActive(this.project);
    untracked(() => {
      const state = this.bridge.peek();
      this.position(state, sceneId);
      const dropped: ProjectClip[] = [];
      const slots = new Map<string, ProjectClip>();
      for (const [key, clip] of state.slots) {
        if (splitSlotKey(key).sceneId === sceneId) dropped.push(clip);
        else slots.set(key, clip);
      }
      this.bridge.write(
        this.withScenes(
          state,
          state.scenes.filter((scene) => scene.id !== sceneId),
          slots,
        ),
        { dropped, droppedIds: [sceneId] },
      );
    });
  }

  /** Copy a scene with every slot clip, right after it or after `afterSceneId`. Copies have their own IDs. */
  duplicateScene(sceneId: string, options: { afterSceneId?: string } = {}): SessionScene {
    assertProjectActive(this.project);
    return untracked(() => {
      const state = this.bridge.peek();
      const index = this.position(state, sceneId);
      const at = options.afterSceneId === undefined ? index + 1 : this.position(state, options.afterSceneId) + 1;
      const scene: SessionScene = Object.freeze({ id: this.bridge.newSceneId(), name: `${state.scenes[index].name} copy` });
      const slots = new Map(state.slots);
      const named = new Map<string, string>();
      for (const [key, clip] of state.slots) {
        const { sceneId: owner, trackId } = splitSlotKey(key);
        if (owner !== sceneId) continue;
        const copy = this.bridge.clone(clip, 0);
        slots.set(slotKey(scene.id, trackId), copy.clip);
        if (copy.name !== undefined) named.set(copy.clip.id, copy.name);
      }
      this.bridge.write(this.withScenes(state, [...state.scenes.slice(0, at), scene, ...state.scenes.slice(at)], slots), { named });
      return scene;
    });
  }

  /** Put a MIDI clip in a slot of a MIDI track, replacing what it held. `data` is what `addMidiClip` takes. */
  setMidiClip(slot: SessionSlot, data: ProjectMidiData, options: { name?: string } = {}): MidiClip {
    assertProjectActive(this.project);
    return untracked(() => {
      const state = this.bridge.peek();
      if (this.check(state, slot) !== "midi") throw wrongKind();
      const made = this.bridge.midi(data, options.name);
      this.fill(state, slot, made.clip, made.name);
      return made.clip;
    });
  }

  /** Put an audio clip in a slot of an audio track, replacing what it held. `audio` is what `addAudioClip` takes. */
  setAudioClip(slot: SessionSlot, audio: ProjectAudio, options: { name?: string } = {}): AudioClip {
    assertProjectActive(this.project);
    return untracked(() => {
      const state = this.bridge.peek();
      if (this.check(state, slot) !== "audio") throw wrongKind();
      const made = this.bridge.audio(audio, options.name);
      this.fill(state, slot, made.clip, made.name);
      return made.clip;
    });
  }

  private fill(state: SessionState, slot: SessionSlot, clip: ProjectClip, name: string | undefined): void {
    const key = slotKey(slot.sceneId, slot.trackId);
    const previous = state.slots.get(key);
    this.bridge.write(this.withScenes(state, state.scenes, new Map(state.slots).set(key, clip)), {
      ...(name === undefined ? {} : { named: new Map([[clip.id, name]]) }),
      ...(previous ? { dropped: [previous] } : {}),
    });
  }

  /** Move a slot's clip to another slot of a track of the same kind, replacing the target's clip. The clip keeps its ID. */
  moveClip(from: SessionSlot, to: SessionSlot): void {
    assertProjectActive(this.project);
    untracked(() => {
      const state = this.bridge.peek();
      this.check(state, from);
      const kind = this.check(state, to);
      const clip = state.slots.get(slotKey(from.sceneId, from.trackId));
      if (!clip) throw emptySlot();
      const target = slotKey(to.sceneId, to.trackId);
      if (target === slotKey(from.sceneId, from.trackId)) return;
      if (clip.kind !== kind) throw wrongKind();
      const replaced = state.slots.get(target);
      const slots = new Map(state.slots);
      slots.delete(slotKey(from.sceneId, from.trackId));
      slots.set(target, clip);
      this.bridge.write(this.withScenes(state, state.scenes, slots), replaced ? { dropped: [replaced] } : {});
    });
  }

  /** Empty a slot. An empty slot is left as it is. */
  clearSlot(slot: SessionSlot): void {
    assertProjectActive(this.project);
    untracked(() => {
      const state = this.bridge.peek();
      this.check(state, slot);
      const key = slotKey(slot.sceneId, slot.trackId);
      const clip = state.slots.get(key);
      if (!clip) return;
      const slots = new Map(state.slots);
      slots.delete(key);
      this.bridge.write(this.withScenes(state, state.scenes, slots), { dropped: [clip] });
    });
  }

  /**
   * Put a copy of a timeline or slot clip in a slot of a track of the same kind, replacing what it held; the source stays where it is.
   * The copy has its own ID. With `linked: true` a MIDI copy shares the source's notes and events, as `duplicateClip(..., { linked: true })` does:
   * an edit through any member changes all, and `makeClipUnique` leaves the group. Only MIDI clips link.
   */
  copyToSlot(clipId: string, slot: SessionSlot, options: { linked?: boolean } = {}): ProjectClip {
    assertProjectActive(this.project);
    return untracked(() => {
      const state = this.bridge.peek();
      const kind = this.check(state, slot);
      const source = this.bridge.find(clipId);
      if (!source) throw new Error("Project clip does not exist.");
      if (source.kind !== kind) throw wrongKind();
      const copy = this.bridge.clone(source, 0, options.linked === true);
      this.fill(state, slot, copy.clip, copy.name);
      return copy.clip;
    });
  }

  /**
   * Place a copy of a slot's clip on the timeline, at `atBeat` or `atSeconds` (exactly one) on the slot's track or on `trackId`, a track of the same kind.
   * The slot keeps its clip. Returns the copy, which has its own ID. With `linked: true` a MIDI copy shares the slot clip's notes (see `copyToSlot`).
   */
  copyToArrangement(slot: SessionSlot, options: { trackId?: string; atBeat?: number; atSeconds?: number; linked?: boolean }): ProjectClip {
    assertProjectActive(this.project);
    return untracked(() => {
      const state = this.bridge.peek();
      this.check(state, slot);
      const clip = state.slots.get(slotKey(slot.sceneId, slot.trackId));
      if (!clip) throw emptySlot();
      const trackId = options.trackId ?? slot.trackId;
      const kind = this.bridge.trackKind(trackId);
      if (!kind) throw unknownSlot();
      if (kind !== clip.kind) throw wrongKind();
      if ((options.atBeat === undefined) === (options.atSeconds === undefined))
        throw new RangeError("Project session copyToArrangement needs exactly one of atBeat and atSeconds.");
      const tempo = this.bridge.tempoMap();
      const time =
        clip.kind === "midi"
          ? (options.atBeat ?? tempo.secondsToBeat(options.atSeconds!))
          : (options.atSeconds ?? tempo.beatToSeconds(options.atBeat!));
      if (!Number.isFinite(time) || time < 0) throw new RangeError("Project clip time must be finite and non-negative.");
      const copy = this.bridge.clone(clip, time, options.linked === true);
      this.bridge.place(trackId, copy.clip, copy.name);
      return copy.clip;
    });
  }
}

/** The one Session grid of this Project: every call with the same Project returns the same object. */
export function sessionFor(project: Project): ProjectSession {
  let session = sessions.get(project);
  if (!session) sessions.set(project, (session = createSession(project)));
  return session;
}
