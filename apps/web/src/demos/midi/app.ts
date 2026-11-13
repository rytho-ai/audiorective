/** Standalone MIDI inspector: shared data/views, caller-owned audition and controls. */
import { MidiSequence, midiGrid } from "@audiorective/blocks/midi";
import { mountPianoRoll, type PianoRollRenderer, type PianoRollHandle } from "@audiorective/widgets/piano-roll";
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
          end = frame.timeToX(note.end);
        const y = frame.pitchToY(note.pitch) + row / 2;
        const half = Math.max(2, row * 0.34),
          width = Math.max(4, end - x);
        const ribbon = document.createElementNS(ns, "polygon");
        ribbon.dataset.noteId = note.id;
        ribbon.setAttribute(
          "points",
          `${x},${y} ${x + Math.min(5, width / 2)},${y - half} ${x + width},${y - half * 0.5} ${x + width},${y + half * 0.5} ${x + Math.min(5, width / 2)},${y + half}`,
        );
        ribbon.setAttribute("fill", `hsl(${210 - note.velocity * 1.3} 85% 62%)`);
        ribbon.setAttribute("stroke", "#eefaff");
        ribbon.setAttribute("stroke-width", ".6");
        ribbon.setAttribute("tabindex", "0");
        ribbon.setAttribute("role", "button");
        ribbon.setAttribute(
          "aria-label",
          `Pitch ${note.pitch}, velocity ${note.velocity}, ${note.start.toFixed(3)} to ${note.end.toFixed(3)} seconds`,
        );
        ribbon.style.cssText = "pointer-events:auto;cursor:pointer";
        ribbon.onpointerdown = (event) => event.stopPropagation();
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
    destroy() {
      svg.remove();
    },
  };
};

export function mountMidiApp(root: HTMLElement, deps: Dependencies): MidiApp {
  const model = new MidiSequence();
  const sound = deps.makeAuditioner(() => model.getState());
  const events = new AbortController();
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
      <label>Scroll to seconds <input data-control="scroll" type="number" min="0" value="0" step="0.1" style="width:80px"></label>
      <label>Seek seconds <input data-control="seek" type="number" min="0" value="0" step="0.1" style="width:80px"></label>
      <button data-control="remove" type="button">Remove second view</button>
    </div>
    <output data-control="summary"></output><output data-control="status" aria-live="polite"></output>
    <fieldset><legend>Inspected note</legend><output data-control="inspection">Click a note in either view.</output>
      <label>Pitch <input data-control="pitch" type="number" min="0" max="127" step="1" disabled></label>
      <label>Velocity <input data-control="velocity" type="number" min="0" max="127" step="1" disabled></label>
    </fieldset>
    <div data-app-view="0"></div><div data-app-view="1" style="--waveform-accent:#df9dff"></div>`;
  root.append(host);
  const control = <T extends HTMLElement>(name: string) => host.querySelector<T>(`[data-control="${name}"]`)!;
  const status = control<HTMLOutputElement>("status");
  const summary = control<HTMLOutputElement>("summary");
  const inspection = control<HTMLOutputElement>("inspection");
  const pitch = control<HTMLInputElement>("pitch"),
    velocity = control<HTMLInputElement>("velocity");
  const firstRoot = host.querySelector<HTMLElement>('[data-app-view="0"]')!;
  const secondRoot = host.querySelector<HTMLElement>('[data-app-view="1"]')!;
  const inspect = (note: Note) => {
    inspectedId = note.id;
    updateSummary();
  };
  const first = mountPianoRoll(firstRoot, { model, snap: "beat", label: "Note buttons", onNoteClick: inspect });
  let second: PianoRollHandle | null = mountPianoRoll(secondRoot, {
    model,
    snap: "beat",
    label: "Velocity ribbons",
    renderer: ribbonRenderer,
    onNoteClick: inspect,
  });
  const views = () => (second ? [first, second] : [first]);
  function updateSummary() {
    const state = model.getState(),
      range = state.selection;
    summary.textContent = `${state.notes.length} notes · ${state.duration.toFixed(3)} seconds · ${range ? `Selection ${range.start.toFixed(3)}–${range.end.toFixed(3)} seconds` : "Full file"}`;
    const note = state.notes.find((value) => value.id === inspectedId);
    pitch.disabled = velocity.disabled = !note;
    if (note) {
      inspection.textContent = `${note.id}: ${note.start.toFixed(3)}–${note.end.toFixed(3)}s, channel ${note.channel}, track ${note.track}. `;
      pitch.value = String(note.pitch);
      velocity.value = String(note.velocity);
    } else inspection.textContent = "Click a note in either view. ";
  }
  const unsubscribe = model.subscribe(updateSummary);
  updateSummary();
  function alive() {
    if (dead) throw new Error("MIDI app is destroyed");
  }
  function editNote(id: string, patch: Partial<Pick<Note, "pitch" | "velocity" | "start" | "end">>) {
    alive();
    sound.pause();
    model.updateNote(id, patch);
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
    sound.pause();
    const parsed = model.load(bytes);
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
    await sound.play();
  }
  function report(error: unknown) {
    status.textContent = error instanceof Error ? error.message : String(error);
  }
  function listen(name: string, type: string, callback: (event: Event) => void) {
    control(name).addEventListener(type, callback, { signal: events.signal });
  }
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
    const seconds = control<HTMLInputElement>("scroll").valueAsNumber;
    if (Number.isFinite(seconds)) for (const view of views()) view.scrollTo(seconds);
  });
  listen("seek", "change", () => {
    const seconds = control<HTMLInputElement>("seek").valueAsNumber;
    if (Number.isFinite(seconds)) sound.seek(seconds);
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
    second.destroy();
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
    seek(seconds: number) {
      alive();
      sound.seek(seconds);
      for (const view of views()) view.setPlayhead(sound.position);
    },
    get position() {
      return sound.position;
    },
    get isPlaying() {
      return sound.isPlaying;
    },
    removeSecondView,
    destroy() {
      if (dead) return;
      dead = true;
      fileRequest++;
      cancelAnimationFrame(animation);
      events.abort();
      sound.destroy();
      first.destroy();
      second?.destroy();
      second = null;
      unsubscribe();
      model.destroy();
      host.remove();
    },
  };
}
