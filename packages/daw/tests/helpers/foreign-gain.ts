import { unzipSync, zipSync } from "fflate";
import { Project, saveDawProject } from "../../src";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export type CurvePoint = { time: number; value: number; interpolation?: "hold" | "linear" };

/**
 * A file another application wrote: one audio clip of `seconds` constant 0.5 audio at `rate`, whose content lanes hold the audio and one
 * gain curve (Bitwig's form: `Lanes > Audio + Points(expression="gain")`). Audiorective's own details are gone.
 */
export function foreignGainFile(
  points: readonly CurvePoint[],
  options: { timeUnit?: "seconds" | "beats"; bpm?: number; seconds?: number; rate?: number } = {},
) {
  const { timeUnit = "seconds", bpm = 120, seconds = 4, rate = 8000 } = options;
  const project = new Project({ bpm });
  const track = project.addTrack("Voice", "audio");
  // Unity gain writes no gain curve, so a gain of 0.5 gets one that is then replaced.
  project.addAudioClip(track.id, { sampleRate: rate, channels: [new Float32Array(seconds * rate).fill(0.5)] }, 0, {
    envelope: { gain: 0.5, fadeIn: 0, fadeOut: 0 },
  });
  const files = unzipSync(saveDawProject(project));
  project.dispose();
  delete files["audiorective/state.json"];
  let xml = decoder.decode(files["project.xml"]);
  xml = xml.replace('<Application name="Audiorective"', '<Application name="Bitwig Studio"');
  const curve = points
    .map((point) => `<RealPoint time="${point.time}" value="${point.value}"${point.interpolation ? ` interpolation="${point.interpolation}"` : ""}/>`)
    .join("");
  xml = xml.replace(
    /<Points [^>]*>[\s\S]*?<\/Points>/,
    `<Points id="gain1" timeUnit="${timeUnit}" unit="linear"><Target expression="gain"/>${curve}</Points>`,
  );
  files["project.xml"] = encoder.encode(xml);
  return { bytes: zipSync(files), xml };
}

export const projectXml = (bytes: Uint8Array) => decoder.decode(unzipSync(bytes)["project.xml"]);
