import { describe, test, expect, vi } from "vitest";
import * as THREE from "three";
import { createEngine, AudioEngine } from "@audiorective/core";
import { attach } from "../src";

function makeRenderer(): THREE.WebGLRenderer {
  // vitest browser has a real DOM, so we can fake a renderer with just a canvas.
  const canvas = document.createElement("canvas");
  return { domElement: canvas } as unknown as THREE.WebGLRenderer;
}

describe("attach", () => {
  test("accepts a bare AudioEngine", () => {
    const engine = new AudioEngine();
    const renderer = makeRenderer();
    const detach = attach(engine, renderer);
    expect(typeof detach).toBe("function");
    detach();
    engine.dispose();
  });

  test("accepts a createEngine wrapper ({ core })", () => {
    const engine = createEngine(() => ({ x: 1 }));
    const renderer = makeRenderer();
    const detach = attach(engine, renderer);
    expect(typeof detach).toBe("function");
    detach();
    engine.core.dispose();
  });

  test("sets the THREE.AudioContext to the engine's context", () => {
    const engine = new AudioEngine();
    const renderer = makeRenderer();
    const detach = attach(engine, renderer);
    expect(THREE.AudioContext.getContext()).toBe(engine.context);
    detach();
    engine.dispose();
  });

  test("resumes the engine on a gesture on renderer.domElement", async () => {
    const context = new AudioContext();
    await context.suspend();
    const engine = new AudioEngine(context);
    const renderer = makeRenderer();
    const detach = attach(engine, renderer);
    renderer.domElement.dispatchEvent(new Event("click"));
    expect(engine.state.value).toBe("suspended");
    await engine.untilReady();
    expect(engine.state.value).toBe("running");
    detach();
    engine.dispose();
  });

  test("returned detach stops the auto-start listener", async () => {
    const context = new AudioContext();
    await context.suspend();
    const engine = new AudioEngine(context);
    const renderer = makeRenderer();
    const detach = attach(engine, renderer);
    detach();
    const startSpy = vi.spyOn(engine, "resume");
    renderer.domElement.dispatchEvent(new Event("click"));
    expect(startSpy).not.toHaveBeenCalled();
    startSpy.mockRestore();
    engine.dispose();
  });
});
