import { expect, test } from "vitest";
import { StepSequencer, type Hit } from "@audiorective/sequencer";
import { Project, Workspace } from "../src";

test("workspace.transport.attach(sequencer) queues hits on the workspace transport and dispose detaches", async () => {
  const context = new OfflineAudioContext(2, 48_000, 48_000);
  const project = new Project({ bpm: 120 });
  const workspace = await Workspace.create(context as unknown as AudioContext, project);
  const seq = new StepSequencer({ kick: "X...", hat: { pattern: "xx", rate: "8n" } });
  const hits: Hit[] = [];
  const first = new Promise<void>((resolve) =>
    seq.addEventListener("hit", (event) => {
      hits.push(event.hit);
      resolve();
    }),
  );
  const detach = workspace.transport.attach(seq);
  workspace.transport.start(0);
  await first;
  expect(hits[0]!.index).toBe(0);
  expect(hits[0]!.when).toBeCloseTo(0, 6);
  expect(hits.every((hit) => hit.lane === "kick" || hit.lane === "hat")).toBe(true);
  seq.dispose();
  const count = hits.length;
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(hits).toHaveLength(count);
  expect(workspace.transport.state.value).toBe("playing"); // the shared transport keeps running
  detach();
  workspace.destroy();
  project.destroy();
});
