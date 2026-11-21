/** MIDI inspector: contrasting layouts/drawing share widget-owned gestures, data and caller audition. */
import { MidiRecorder } from "@audiorective/midi/web";
import { batch, cell } from "@audiorective/core";
import { MidiClip, midiGrid, parseMidi, type MidiPlaybackSource, type MidiTake } from "@audiorective/midi";
import { mountPianoRoll, pianoRollModel, type PianoRollRenderer, type PianoRollHandle } from "@audiorective/widgets/piano-roll";
import { rightKeyboardLayout } from "./layout";
import type { Dependencies, MidiApp, Note, Range } from "./audition";

/** The custom view draws a velocity-colored ribbon with an onset diamond. */
const ribbonRenderer: PianoRollRenderer = (root) => {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("aria-label", "Velocity ribbon piano roll");
  svg.style.cssText = "display:block;overflow:hidden;width:100%;height:100%";
  root.append(svg);
  return {
    render(frame) {
      svg.setAttribute("viewBox", `0 0 ${frame.width} ${frame.height}`);
      const row = frame.height / (frame.pitches.high - frame.pitches.low + 1);
      const elements = frame.notes.map((note) => {
        const x = frame.timeToX(note.start),
          end = frame.timeToX(note.start + note.duration);
        const y = frame.pitchToY(note.pitch) + row / 2;
        const half = Math.max(2, row * 0.34),
          width = Math.max(4, end - x);
        const ribbon = document.createElementNS(ns, "polygon");
        ribbon.dataset.noteId = note.id;
        ribbon.setAttribute(
          "points",
          `${x},${y} ${x + Math.min(5, width / 2)},${y - half} ${x + width},${y - half * 0.5} ${x + width},${y + half * 0.5} ${x + Math.min(5, width / 2)},${y + half}`,
        );
        ribbon.setAttribute("fill", `hsl(${210 - note.velocity * 165} 85% 62%)`);
        ribbon.setAttribute("stroke", "#eefaff");
        ribbon.setAttribute("stroke-width", ".6");
        ribbon.setAttribute("tabindex", "0");
        ribbon.setAttribute("role", "button");
        ribbon.setAttribute(
          "aria-label",
          `Pitch ${note.pitch}, velocity ${note.velocity.toFixed(2)}, ${note.start.toFixed(3)} to ${(note.start + note.duration).toFixed(3)} beats`,
        );
        ribbon.style.cssText = "pointer-events:auto;cursor:pointer";
        ribbon.onpointerdown = (event) => frame.onNotePointerDown(note, event);
        ribbon.onclick = () => frame.onNoteClick(note);
        ribbon.onkeydown = (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            frame.onNoteClick(note);
          }
        };
        return ribbon;
      });
      svg.replaceChildren(...elements);
    },
    dispose() {
      svg.remove();
    },
  };
};

export function mountMidiApp(root: HTMLElement, deps: Dependencies): MidiApp {
  const clip = new MidiClip();
  const length = cell(4);
  const model = pianoRollModel(clip, { duration: () => length.value });
  let recordedSource: MidiPlaybackSource | null = null;
  const sound = deps.makeAuditioner(() => ({ ...model.getState(), source: recordedSource }));
  const events = new AbortController();
  let midiAccess: MIDIAccess | null = null;
  let accessPromise: Promise<MIDIAccess> | null = null;
  let recorder: MidiRecorder | null = null;
  const openedInputs = new Set<MIDIInput>();
  let startingRecord = false;
  let recordRequest = 0;
  let dead = false,
    fileRequest = 0,
    inspectedId: string | null = null;
  const host = document.createElement("section");
  host.style.cssText = "font:14px system-ui;color:#e8edf4;background:#0b121c;padding:16px;display:grid;gap:12px";
  host.innerHTML = `<h2 style="margin:0">MIDI inspector</h2>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <label>Open MIDI <input data-control="source" type="file" accept=".mid,.midi,audio/midi"></label>
      <button data-control="play" type="button">Play</button><button data-control="pause" type="button">Pause</button>
      <label>Snap <select data-control="snap"><option value="beat">Beat</option><option value="downbeat">Bar</option><option value="off">Off</option></select></label>
      <label>Scroll to beat <input data-control="scroll" type="number" min="0" value="0" step="0.1" style="width:80px"></label>
      <label>Seek beat <input data-control="seek" type="number" min="0" value="0" step="0.1" style="width:80px"></label>
      <button data-control="remove" type="button">Remove second view</button>
    </div>
    <fieldset><legend>Record MIDI take</legend><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <button data-control="midi-access" type="button">Connect MIDI keyboard</button>
      <label>Input <select data-control="midi-input" disabled><option value="">No MIDI input</option></select></label>
      <button data-control="record" type="button" disabled>Record</button>
      <button data-control="stop-record" type="button" disabled>Stop recording</button>
      <button data-control="cancel-record" type="button" disabled>Discard take</button>
    </div></fieldset>
    <output data-control="summary"></output><output data-control="status" aria-live="polite"></output>
    <fieldset><legend>Inspected note</legend><output data-control="inspection">Click a note in either view.</output>
      <label>Pitch <input data-control="pitch" type="number" min="0" max="127" step="1" disabled></label>
      <label>Velocity <input data-control="velocity" type="number" min="0" max="1" step="0.01" disabled></label>
    </fieldset>
    <div data-app-view="0"></div><div data-app-view="1" style="--waveform-accent:#df9dff"></div>`;
  root.append(host);
  const control = <T extends HTMLElement>(name: string) => host.querySelector<T>(`[data-control="${name}"]`)!;
  const status = control<HTMLOutputElement>("status");
  const summary = control<HTMLOutputElement>("summary");
  const inspection = control<HTMLOutputElement>("inspection");
  const pitch = control<HTMLInputElement>("pitch"),
    velocity = control<HTMLInputElement>("velocity");
  const midiInput = control<HTMLSelectElement>("midi-input");
  const firstRoot = host.querySelector<HTMLElement>('[data-app-view="0"]')!;
  const secondRoot = host.querySelector<HTMLElement>('[data-app-view="1"]')!;
  const inspect = (note: Note) => {
    inspectedId = note.id;
    updateSummary();
  };
  const onNoteEdit: NonNullable<Parameters<typeof mountPianoRoll>[1]["onNoteEdit"]> = ({ note }) =>
    editNote(note.id, { start: note.start, duration: note.duration, pitch: note.pitch });
  const first = mountPianoRoll(firstRoot, { model, snap: "beat", label: "Note buttons", onNoteClick: inspect, onNoteEdit });
  let second: PianoRollHandle | null = mountPianoRoll(secondRoot, {
    model,
    snap: "beat",
    label: "Velocity ribbons",
    renderer: ribbonRenderer,
    layout: rightKeyboardLayout,
    onNoteEdit,
    onNoteClick: inspect,
  });
  const views = () => (second ? [first, second] : [first]);
  function updateSummary() {
    const state = model.getState(),
      range = state.selection;
    summary.textContent = `${state.notes.length} notes · ${state.duration.toFixed(3)} beats · ${range ? `Selection ${range.start.toFixed(3)}–${range.end.toFixed(3)} beats` : recordedSource ? "Full take" : "Full file"}`;
    const note = state.notes.find((value) => value.id === inspectedId);
    pitch.disabled = velocity.disabled = !note;
    if (note) {
      inspection.textContent = `${note.id}: ${note.start.toFixed(3)}–${(note.start + note.duration).toFixed(3)} beats, channel ${note.channel}. `;
      pitch.value = String(note.pitch);
      velocity.value = note.velocity.toFixed(2);
    } else inspection.textContent = "Click a note in either view. ";
  }
  const unsubscribe = model.subscribe(updateSummary);
  updateSummary();
  function alive() {
    if (dead) throw new Error("MIDI app is disposed");
  }
  function editNote(id: string, patch: Partial<Pick<Note, "pitch" | "velocity" | "start" | "duration">>) {
    alive();
    sound.pause();
    clip.edit((draft) => {
      const note = draft.find((value) => value.id === id);
      if (!note) throw new Error(`MIDI note ${id} does not exist.`);
      Object.assign(note, patch);
    });
    fitPitches();
  }
  function fitPitches() {
    const notes = model.getState().notes;
    let low = 48,
      high = 72;
    for (const note of notes) {
      low = Math.min(low, note.pitch);
      high = Math.max(high, note.pitch);
    }
    for (const view of views()) view.setPitchRange({ low: Math.max(0, low - 2), high: Math.min(127, high + 2) });
  }
  function load(bytes: ArrayBuffer | Uint8Array) {
    alive();
    cancelRecording();
    sound.pause();
    const parsed = parseMidi(bytes);
    batch(() => {
      clip.setNotes(parsed.notes);
      length.value = parsed.duration;
      model.setSelection(null);
    });
    recordedSource = null;
    sound.seek(0);
    inspectedId = null;
    const grid = midiGrid(parsed);
    for (const view of views()) {
      view.setGrid(grid);
      view.setPlayhead(0);
      view.scrollTo(0);
    }
    fitPitches();
    updateSummary();
    status.textContent = "MIDI loaded";
  }
  async function play() {
    alive();
    if (recorder || startingRecord) throw new Error("Stop MIDI recording before playback.");
    await sound.play();
  }
  function report(error: unknown) {
    status.textContent = error instanceof Error ? error.message : String(error);
  }
  function listen(name: string, type: string, callback: (event: Event) => void) {
    control(name).addEventListener(type, callback, { signal: events.signal });
  }
  function refreshInputs() {
    if (dead) return;
    const previous = midiInput.value;
    const inputs = [...(midiAccess?.inputs.values() ?? [])].filter((input) => input.state === "connected");
    midiInput.replaceChildren(
      ...inputs.map((input) => {
        const option = document.createElement("option");
        option.value = input.id;
        option.textContent = input.name || input.id;
        return option;
      }),
    );
    if (inputs.some((input) => input.id === previous)) midiInput.value = previous;
    if (recorder && !inputs.some((input) => input.id === recorder?.input.id)) {
      cancelRecording();
      status.textContent = "MIDI input disconnected; take discarded.";
    }
    midiInput.disabled = !!recorder || startingRecord || inputs.length === 0;
    control<HTMLButtonElement>("record").disabled = !!recorder || startingRecord || inputs.length === 0;
    control<HTMLButtonElement>("stop-record").disabled = !recorder;
    control<HTMLButtonElement>("cancel-record").disabled = !recorder;
    control<HTMLButtonElement>("play").disabled = !!recorder || startingRecord;
  }
  async function connectMidi() {
    if (!navigator.requestMIDIAccess) throw new Error("Web MIDI is unavailable in this browser or context.");
    if (!midiAccess) {
      let access: MIDIAccess;
      try {
        access = await (accessPromise ??= navigator.requestMIDIAccess());
      } catch (error) {
        accessPromise = null;
        throw error;
      }
      if (dead) return;
      if (!midiAccess) {
        midiAccess = access;
        access.addEventListener("statechange", refreshInputs, { signal: events.signal });
      }
    }
    refreshInputs();
    status.textContent = midiInput.options.length ? "Choose a MIDI input, then record." : "No connected MIDI input.";
  }
  function cancelRecording() {
    ++recordRequest;
    if (!recorder) return;
    recorder.cancel();
    recorder.dispose();
    recorder = null;
    refreshInputs();
  }
  async function startRecording() {
    alive();
    if (recorder || startingRecord) return;
    const input = midiAccess?.inputs.get(midiInput.value);
    if (!input || input.state !== "connected") throw new Error("Choose a connected MIDI input.");
    const token = ++recordRequest;
    startingRecord = true;
    refreshInputs();
    try {
      await deps.context.resume();
      await input.open();
      if (dead || token !== recordRequest) {
        void input.close().catch(() => {});
        return;
      }
      openedInputs.add(input);
      if (input.state !== "connected") throw new Error("MIDI input disconnected before recording.");
      sound.pause();
      const next = new MidiRecorder(deps.context, input);
      recorder = next;
      next.record().then(
        (take) => {
          if (recorder === next) finishRecording(next, take);
        },
        (error: unknown) => {
          if (recorder !== next || (error instanceof DOMException && error.name === "AbortError")) return;
          next.dispose();
          recorder = null;
          refreshInputs();
          report(error);
        },
      );
      status.textContent = "Recording MIDI take…";
    } finally {
      startingRecord = false;
      refreshInputs();
    }
  }
  function stopRecording() {
    alive();
    if (recorder) void recorder.stop().catch(report);
  }
  /** The take's notes are beats at the demo tempo (no clock is attached); its other messages keep the pedal in playback. */
  function finishRecording(finished: MidiRecorder, take: MidiTake) {
    if (dead) return;
    finished.dispose();
    recorder = null;
    sound.pause();
    recordedSource = { events: take.events };
    batch(() => {
      clip.setNotes(take.notes);
      length.value = take.duration;
      model.setSelection(null);
    });
    sound.seek(0);
    inspectedId = null;
    const emptyGrid = { beats: [], downbeats: [] };
    for (const view of views()) {
      view.setGrid(emptyGrid);
      view.setSnap("off");
      view.setPlayhead(0);
      view.scrollTo(0);
    }
    control<HTMLSelectElement>("snap").value = "off";
    fitPitches();
    updateSummary();
    refreshInputs();
    status.textContent = `Recorded ${take.notes.length} notes and ${take.events.length} messages. Edit, then Play to audition.`;
  }
  listen("midi-access", "click", () => {
    void connectMidi().catch(report);
  });
  listen("record", "click", () => {
    void startRecording().catch(report);
  });
  listen("stop-record", "click", () => {
    try {
      stopRecording();
    } catch (error) {
      report(error);
    }
  });
  listen("cancel-record", "click", () => {
    cancelRecording();
    status.textContent = "MIDI take discarded.";
  });
  listen("source", "change", () => {
    const file = control<HTMLInputElement>("source").files?.[0],
      token = ++fileRequest;
    if (file)
      void file
        .arrayBuffer()
        .then((bytes) => {
          if (!dead && token === fileRequest) load(bytes);
        })
        .catch((error: unknown) => {
          if (!dead && token === fileRequest) report(error);
        });
  });
  listen("play", "click", () => {
    void play().catch(report);
  });
  listen("pause", "click", () => sound.pause());
  listen("snap", "change", () => {
    const mode = control<HTMLSelectElement>("snap").value;
    if (mode === "off" || mode === "beat" || mode === "downbeat") for (const view of views()) view.setSnap(mode);
  });
  listen("scroll", "change", () => {
    const beat = control<HTMLInputElement>("scroll").valueAsNumber;
    if (Number.isFinite(beat)) for (const view of views()) view.scrollTo(beat);
  });
  listen("seek", "change", () => {
    const beat = control<HTMLInputElement>("seek").valueAsNumber;
    if (Number.isFinite(beat)) sound.seek(beat);
  });
  listen("pitch", "change", () => {
    if (inspectedId)
      try {
        editNote(inspectedId, { pitch: pitch.valueAsNumber });
      } catch (error) {
        report(error);
      }
  });
  listen("velocity", "change", () => {
    if (inspectedId)
      try {
        editNote(inspectedId, { velocity: velocity.valueAsNumber });
      } catch (error) {
        report(error);
      }
  });
  function removeSecondView() {
    if (dead || !second) return;
    second.dispose();
    second = null;
    secondRoot.remove();
    control<HTMLButtonElement>("remove").disabled = true;
  }
  listen("remove", "click", removeSecondView);
  let animation = 0;
  const tick = () => {
    if (dead) return;
    for (const view of views()) view.setPlayhead(sound.position);
    control<HTMLButtonElement>("play").textContent = sound.isPlaying ? "Playing" : "Play";
    animation = requestAnimationFrame(tick);
  };
  animation = requestAnimationFrame(tick);
  return {
    load,
    getState: () => model.getState(),
    setSelection(range: Range | null) {
      alive();
      model.setSelection(range);
    },
    editNote,
    play,
    pause() {
      if (!dead) sound.pause();
    },
    seek(beat: number) {
      alive();
      sound.seek(beat);
      for (const view of views()) view.setPlayhead(sound.position);
    },
    get position() {
      return sound.position;
    },
    get isPlaying() {
      return sound.isPlaying;
    },
    removeSecondView,
    dispose() {
      if (dead) return;
      dead = true;
      fileRequest++;
      cancelAnimationFrame(animation);
      events.abort();
      cancelRecording();
      for (const input of openedInputs) void input.close().catch(() => {});
      openedInputs.clear();
      sound.dispose();
      first.dispose();
      second?.dispose();
      second = null;
      unsubscribe();
      model.dispose();
      clip.dispose();
      host.remove();
    },
  };
}
