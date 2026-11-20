// @ts-check
import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import starlight from "@astrojs/starlight";

export default defineConfig({
  output: "static",
  site: "https://audiorective-showroom.vercel.app",
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
            { label: "Blocks", slug: "docs/blocks" },
            { label: "WavePlayer", slug: "docs/player" },
            { label: "Audio Recorder", slug: "docs/recorder" },
            { label: "Pad Bank", slug: "docs/pads" },
            { label: "Step Sequencer", slug: "docs/sequencer" },
            { label: "Step Sequencer: advanced", slug: "docs/sequencer-advanced" },
            { label: "Sample Library", slug: "docs/samples" },
            { label: "Clip Launcher", slug: "docs/launcher" },
            { label: "Widgets", slug: "docs/widgets" },
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
