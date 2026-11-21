// @ts-check
import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import starlight from "@astrojs/starlight";
import { unified } from "@astrojs/markdown-remark";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const docsDirectory = resolve(fileURLToPath(new URL("../../docs", import.meta.url)));
const publishedDocs = new Set(
  readdirSync(docsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name),
);

/** @typedef {{ type: string; url?: string; children?: MarkdownNode[] }} MarkdownNode */
/** Keep repository/skill Markdown links intact while rendering known sibling docs as site routes.
 * @returns {(tree: MarkdownNode, file: { path?: string }) => void}
 */
function remarkDocLinks() {
  return (tree, file) => {
    if (!file.path || dirname(file.path) !== docsDirectory) return;
    /** @param {MarkdownNode} node */
    const visit = (node) => {
      if ((node.type === "link" || node.type === "definition") && node.url) {
        const target = /^\.\/([^/\\?#]+)\.md([?#].*)?$/.exec(node.url);
        if (target && publishedDocs.has(`${target[1]}.md`)) node.url = `/docs/${target[1]}/${target[2] ?? ""}`;
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree);
  };
}

export default defineConfig({
  output: "static",
  site: "https://audiorective-showroom.vercel.app",
  markdown: { processor: unified({ remarkPlugins: [remarkDocLinks] }) },
  integrations: [
    starlight({
      title: "Audiorective",
      customCss: ["./src/styles/docs.css"],
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/audiorective/audiorective" }],
      sidebar: [
        {
          label: "Start",
          items: [
            { label: "Overview", slug: "docs/overview" },
            { label: "Get Started", slug: "docs/get-started" },
            { label: "Installation", slug: "docs/installation" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { label: "Architecture", slug: "docs/architecture" },
            { label: "Designing Audio Apps", slug: "docs/designing-audio-apps" },
            { label: "Choosing Playback", slug: "docs/choosing-playback" },
            { label: "Server-rendered Frameworks", slug: "docs/client-boundary" },
            { label: "Rules in depth", slug: "docs/rules-in-depth" },
          ],
        },
        {
          label: "Packages",
          items: [
            { label: "Core", slug: "docs/core" },
            { label: "Automation", slug: "docs/automation" },
            { label: "Clock", slug: "docs/clock" },
            { label: "React", slug: "docs/react" },
            { label: "Three.js", slug: "docs/threejs" },
            { label: "PlayCanvas", slug: "docs/playcanvas" },
            { label: "Effects", slug: "docs/effects" },
            {
              label: "Capabilities",
              items: [
                { label: "Player", slug: "docs/player" },
                { label: "Recorder", slug: "docs/recorder" },
                { label: "Pads", slug: "docs/pads" },
                { label: "Sequencer", slug: "docs/sequencer" },
                { label: "Sequencer: advanced", slug: "docs/sequencer-advanced" },
                { label: "Samples", slug: "docs/samples" },
                { label: "Launcher", slug: "docs/launcher" },
                { label: "Launcher: advanced", slug: "docs/launcher-advanced" },
              ],
            },
            { label: "Widgets", slug: "docs/widgets" },
            { label: "Widgets: advanced", slug: "docs/widgets-advanced" },
            { label: "MIDI and Piano Roll", slug: "docs/midi" },
            { label: "DAW and DAWproject", slug: "docs/daw" },
            { label: "WebCLAP host", slug: "docs/host" },
            { label: "Devtools", slug: "docs/devtools" },
          ],
        },
        { label: "Integration guides", items: [{ label: "PixiJS", slug: "docs/pixijs" }] },
      ],
    }),
    react(),
  ],
});
