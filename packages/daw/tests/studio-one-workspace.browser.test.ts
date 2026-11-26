import { expect, test } from "vitest";
import { unzipSync } from "fflate";
import { openWorkspaceBlob, saveWorkspace } from "../src";
import type { AudioClip } from "../src";
import { parseTree, projectXmlOf, treeDifferences } from "./helpers/xml-tree";

/**
 * Part of `pnpm --filter @audiorective/daw probe:studio-one`, which sets VITE_STUDIO_ONE_FILE to the downloaded PreSonus export (27.7 MB, not stored in the
 * repository) and runs this file in a browser: the file opens in a Workspace, the browser decodes its Ogg audio, and an unchanged save writes it back.
 * Without that variable the test is skipped.
 */
const file = import.meta.env.VITE_STUDIO_ONE_FILE as string | undefined;

test.skipIf(!file)(
  "the Studio One export opens in a Workspace with its Ogg audio decoded, and an unchanged save writes it back",
  { timeout: 120_000 },
  async () => {
    const response = await fetch(`/@fs${file}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const context = new AudioContext({ sampleRate: 48_000 });
    const started = performance.now();
    const workspace = await openWorkspaceBlob(context, new Blob([bytes as Uint8Array<ArrayBuffer>]));
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    const clips = workspace.project.tracks.flatMap((track) => track.clips).filter((clip): clip is AudioClip => clip.kind === "audio");
    const decoded = clips.filter((clip) => !clip.media);
    const files = new Set(Object.keys(unzipSync(bytes)).filter((name) => name.endsWith(".ogg")));
    const refused = workspace.warnings.filter((warning) => /could not decode/.test(warning));
    console.log(
      `Studio One export in a browser Workspace at 48 kHz: ${clips.length} audio clips, ${decoded.length} decoded to PCM (${files.size} Ogg files in the archive), opened in ${seconds} s.`,
    );
    console.log(`${workspace.warnings.length} warnings; ${refused.length} name a file the browser could not decode.`);
    for (const warning of refused) console.log(`  - ${warning.slice(0, 300)}`);
    expect(clips.length).toBeGreaterThan(0);
    expect(decoded.length).toBe(clips.length);
    const saved = await saveWorkspace(workspace);
    expect(treeDifferences(parseTree(projectXmlOf(bytes)), parseTree(projectXmlOf(saved)))).toEqual([]);
    const before = unzipSync(bytes);
    const after = unzipSync(saved);
    const changed = [...files].filter(
      (name) => !after[name] || after[name].length !== before[name].length || after[name].some((byte, i) => byte !== before[name][i]),
    );
    console.log(`An unchanged save leaves project.xml the same tree and ${files.size - changed.length} of ${files.size} Ogg files byte for byte.`);
    expect(changed).toEqual([]);
    workspace.dispose();
    await context.close();
  },
);
