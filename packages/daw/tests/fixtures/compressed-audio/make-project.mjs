/**
 * Builds compressed-audio.dawproject from the click files next to it: `node make-project.mjs` (needs fflate from packages/daw).
 * The structure follows what PreSonus Studio One 7 writes (a master bus Track, audio in a nested Clip with Warps) for the Ogg clip, and the
 * plain form (Clip > Audio with playStart/playStop) for the others. Every click is 0.5 s into its 1 s file; the tempo is 120 BPM, so a beat is 0.5 s.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";

const here = (name) => new URL(name, import.meta.url);
const files = { ogg: "click.ogg", flac: "click.flac", mp3: "click.mp3", opus: "click.opus", broken: "broken.ogg" };
const formats = {
  ogg: { rate: 44100, channels: 2 },
  flac: { rate: 48000, channels: 1 },
  mp3: { rate: 44100, channels: 1 },
  opus: { rate: 48000, channels: 1 },
  broken: { rate: 44100, channels: 1 },
};
const audio = (key, id) =>
  `<Audio id="a${id}" timeUnit="seconds" sampleRate="${formats[key].rate}" duration="1.000000" channels="${formats[key].channels}"><File external="false" path="audio/${files[key]}"/></Audio>`;
const lanes = [];
const tracks = [];
const add = (key, name, clip) => {
  const n = tracks.length + 1;
  tracks.push(
    `<Track id="t${n}" name="${name}" contentType="audio" loaded="true"><Channel id="c${n}" name="${name}" role="regular" audioChannels="2" destination="bus"><Volume id="v${n}" unit="linear" min="0" max="3.1622" value="1"/><Mute id="m${n}" value="false"/></Channel></Track>`,
  );
  lanes.push(`<Lanes id="l${n}" track="t${n}"><Clips id="k${n}">${clip(n)}</Clips></Lanes>`);
};
// Studio One's nested form: an outer Clip around a Clips with one inner Clip whose Warps hold the Audio; identity warp (2 beats = 1 s).
add(
  "ogg",
  "Ogg",
  (n) =>
    `<Clip name="Ogg click" contentTimeUnit="beats" fadeTimeUnit="beats" time="2.000000" duration="2.000000" playStart="0.000000"><Clips id="n${n}"><Clip contentTimeUnit="beats" fadeTimeUnit="beats" time="0.000000" duration="2.000000"><Warps id="w${n}" contentTimeUnit="seconds">${audio("ogg", n)}<Warp time="0.000000" contentTime="0.000000"/><Warp time="2.000000" contentTime="1.000000"/></Warps></Clip></Clips></Clip>`,
);
// A window into the file: 0.25 s to 0.75 s, placed at beat 2 (1 s), so the click is 0.25 s into the clip.
add(
  "flac",
  "Flac",
  (n) =>
    `<Clip name="Flac click" contentTimeUnit="seconds" fadeTimeUnit="beats" time="2.000000" duration="1.000000" playStart="0.250000" playStop="0.750000">${audio("flac", n)}</Clip>`,
);
add(
  "mp3",
  "Mp3",
  (n) => `<Clip name="Mp3 click" contentTimeUnit="seconds" fadeTimeUnit="beats" time="4.000000" duration="2.000000">${audio("mp3", n)}</Clip>`,
);
add(
  "opus",
  "Opus",
  (n) => `<Clip name="Opus click" contentTimeUnit="seconds" fadeTimeUnit="beats" time="8.000000" duration="2.000000">${audio("opus", n)}</Clip>`,
);
add(
  "broken",
  "Broken",
  (n) => `<Clip name="Broken" contentTimeUnit="seconds" fadeTimeUnit="beats" time="12.000000" duration="2.000000">${audio("broken", n)}</Clip>`,
);
const project = `<?xml version="1.0" encoding="UTF-8"?>
<Project version="1.0"><Application version="7.0.2.103351" name="Studio One"/><Transport><Tempo id="tempo" value="120.000000" max="400.000000" min="10.000000" unit="bpm"/><TimeSignature id="sig" numerator="4" denominator="4"/></Transport><Structure>${tracks.join("")}<Track id="tbus" name="Bus" contentType="tracks" loaded="true"><Channel id="bus" name="Bus" role="master" audioChannels="2"><Volume id="vbus" unit="linear" min="0" max="3.1622" value="1"/></Channel></Track></Structure><Arrangement id="arr"><Lanes id="lanes" timeUnit="beats">${lanes.join("")}</Lanes></Arrangement></Project>`;
const entries = {
  "project.xml": strToU8(project),
  "metadata.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><MetaData><Title>Compressed audio</Title></MetaData>`),
};
for (const name of Object.values(files)) entries[`audio/${name}`] = new Uint8Array(readFileSync(here(name)));
writeFileSync(here("compressed-audio.dawproject"), zipSync(entries, { level: 6, mtime: new Date(2026, 10, 26) }));
