import { parseMidi, writeMidi, type MidiFileEvent, type MidiWriteTrack } from "@audiorective/midi";
import { compileControllerLane, controllerLaneKey, controllerMessage, messageLaneKey } from "./controller-lane";
import { MidiClip, type Project, type ProjectTrack } from "./model";

/** What `importMidiFile` did. */
export type MidiFileImport = Readonly<{
  /** The tracks that were created, one per MIDI file track that has notes or controller moves, in file order, as the project holds them after the import. */
  tracks: readonly ProjectTrack[];
  /** `"file"`: the song's tempo and meter map were replaced by the file's. `"song"`: the song kept its own. */
  tempoMapUsed: "file" | "song";
  /** What the import left out or changed, in plain sentences. */
  warnings: readonly string[];
}>;

export type MidiFileImportOptions = Readonly<{
  /** `"file"` (default) replaces the song's tempo changes and time signatures with the file's; `"song"` keeps the song's and places the notes at their beats. */
  tempo?: "file" | "song";
}>;

const EPS = 1e-9;

/** `text` without the characters XML 1.0 cannot hold, trimmed: for names taken from files. */
/** @internal Shared with the audio import. */
export function xmlSafeName(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || code >= 0x10000)
      out += char;
  }
  return out.trim();
}

/**
 * Adds the tracks of a Standard MIDI File (format 0 or 1, PPQ time division) to `project` as one undoable edit.
 * Each file track with notes or controller moves becomes a MIDI track named after its track-name meta event (`Track N` without one) with a clip at beat 0 that ends on the first bar line
 * at or after the track's content. Note channels are kept on the notes; controllers, pedal, pitch bend, program changes and pressure go into the clip as events.
 * With `tempo: "file"` (the default) the song's tempo changes and time signatures become the file's (a beat is a quarter note, so ticks convert exactly); a file without tempo or meter events leaves the song's.
 * Throws `Invalid MIDI file.` for malformed bytes. Reading a `File` belongs to the caller: `new Uint8Array(await file.arrayBuffer())`.
 */
export function importMidiFile(project: Project, bytes: Uint8Array, options: MidiFileImportOptions = {}): MidiFileImport {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("importMidiFile needs the file's bytes as a Uint8Array.");
  const wanted = options.tempo ?? "file";
  if (wanted !== "file" && wanted !== "song") throw new RangeError(`importMidiFile tempo must be "file" or "song", got "${String(wanted)}".`);
  const parsed = parseMidi(bytes);
  const warnings: string[] = [];
  const created: string[] = [];
  let used: "file" | "song" = "song";
  project.edit("Import MIDI file", () => {
    const hasMaps = parsed.tempos.length > 0 || parsed.signatures.length > 0;
    if (wanted === "file" && hasMaps) {
      const [first] = parsed.tempos;
      project.setTempoChanges([...(first?.beat === 0 ? [] : [{ beat: 0, bpm: 120 }]), ...parsed.tempos.map(({ beat, bpm }) => ({ beat, bpm }))]);
      const signatures = parsed.signatures.filter((s, i, all) => i === all.length - 1 || all[i + 1].beat !== s.beat);
      const [firstSignature] = signatures;
      project.setTimeSignatureChanges([
        ...(firstSignature?.beat === 0 ? [] : [{ beat: 0, numerator: 4, denominator: 4 }]),
        ...signatures.map(({ beat, numerator, denominator }) => ({ beat, numerator, denominator })),
      ]);
      used = "file";
    } else if (wanted === "file") warnings.push("The file has no tempo or time signature; the song's tempo map was kept.");
    else if (hasMaps)
      warnings.push("The file's tempo and time signature changes were not used; its notes keep their beats under the song's tempo map.");
    const meter = project.meterMap;
    for (const track of parsed.tracks) {
      if (!track.notes.length && !track.events.length) continue;
      const channels = new Set(track.notes.map((note) => note.channel));
      if (channels.size > 1)
        warnings.push(
          `Track ${track.index + 1} uses channels ${[...channels]
            .sort((a, b) => a - b)
            .map((channel) => channel + 1)
            .join(", ")} together; they stay on one project track, each note keeping its channel.`,
        );
      let end = track.end;
      for (const note of track.notes) end = Math.max(end, note.start + note.duration);
      for (const event of track.events) end = Math.max(end, event.beat);
      const duration = Math.max(meter.ceilToBar(Math.max(end, EPS)), meter.barToBeat(2) - meter.barToBeat(1));
      const name = xmlSafeName(track.name ?? "") || `Track ${track.index + 1}`;
      const added = project.addTrack(name, "midi");
      project.addMidiClip(
        added.id,
        {
          notes: track.notes.map(({ pitch, velocity, start, duration: length, channel }) => ({ pitch, velocity, start, duration: length, channel })),
          duration,
          events: track.events.map(({ beat, data }) => ({ time: beat, data })),
        },
        0,
        { name },
      );
      created.push(added.id);
    }
    if (!created.length) warnings.push("The file has no track with notes or controller moves, so no track was added.");
  });
  const tracks = project.tracks.filter((track) => created.includes(track.id));
  return Object.freeze({ tracks: Object.freeze(tracks), tempoMapUsed: used, warnings: Object.freeze(warnings) });
}

export type MidiFileExportOptions = Readonly<{
  /** Ticks per quarter note. Default 960. */
  ppq?: number;
  /** Omit repeated status bytes. Default false. */
  runningStatus?: boolean;
}>;

/**
 * The song's MIDI tracks as a Standard MIDI File, format 1: a first track with the title, tempo changes and time signatures, then one track per MIDI track.
 * Each track holds its timeline clips as they play: windows (`sourceOffset`), loops and linked clips are expanded, notes cut at clip edges as playback cuts them,
 * channels and controller, pedal, pitch-bend and program events are kept, and the track's controller lanes are sampled into events as playback sends them. A lane
 * replaces the clips' own events for the same expression, channel and controller. At one beat the lane's messages come before the clips' notes. Audio and bus tracks, Session slot clips, volume, pan, mute and devices are not exported.
 * Bytes only: the caller saves them, for example `new Blob([bytes], { type: "audio/midi" })`.
 */
export function exportMidiFile(project: Project, options: MidiFileExportOptions = {}): Uint8Array<ArrayBuffer> {
  const tracks: MidiWriteTrack[] = [];
  for (const track of project.tracks) {
    if (track.kind !== "midi") continue;
    const events: MidiFileEvent[] = [];
    let end = 0;
    // The track's controller lanes come first, program changes before the rest, so at one beat they precede the clips' notes (the file writer puts note-offs
    // before them and note-ons after). A lane replaces the clips' own events for the same controller, as in playback.
    const lanes = [...track.controllerLanes].sort((a, b) => Number(b.expression === "programChange") - Number(a.expression === "programChange"));
    const laneKeys = new Set(lanes.map(controllerLaneKey));
    for (const lane of lanes)
      for (const { beat, value } of compileControllerLane(lane)) {
        events.push({ beat, data: controllerMessage(lane, value) });
        end = Math.max(end, beat);
      }
    for (const clip of track.clips) {
      if (!(clip instanceof MidiClip)) continue;
      end = Math.max(end, clip.time + clip.duration);
      for (const { beat, data } of clip.playbackEvents()) {
        const key = messageLaneKey(data);
        if (key === undefined || !laneKeys.has(key)) events.push({ beat: clip.time + beat, data });
      }
    }
    const isProgram = ({ data }: MidiFileEvent) => (data[0] & 0xf0) === 0xc0;
    events.sort((a, b) => a.beat - b.beat || Number(isProgram(b)) - Number(isProgram(a)));
    tracks.push({ name: track.name, events, end });
  }
  return writeMidi({
    ...(options.ppq === undefined ? {} : { ppq: options.ppq }),
    ...(options.runningStatus === undefined ? {} : { runningStatus: options.runningStatus }),
    title: project.title,
    tempos: [{ beat: 0, bpm: project.bpm }, ...project.tempoMap.changes],
    signatures: [{ beat: 0, numerator: project.signature[0], denominator: project.signature[1] }, ...project.meterMap.changes],
    tracks,
  });
}
