import { commands } from "vitest/browser";

export type PointerAction = {
  action: "down" | "move" | "up";
  x?: number;
  y?: number;
  alt?: boolean;
};

declare module "vitest/browser" {
  interface BrowserCommands {
    waveformPointer(action: PointerAction): Promise<void>;
  }
}

const disposers: Array<() => void | Promise<void>> = [];

export function own(dispose: () => void | Promise<void>): void {
  disposers.push(dispose);
}

export async function cleanup(): Promise<void> {
  try {
    await commands.waveformPointer({ action: "up" });
  } finally {
    for (const dispose of disposers.splice(0).reverse()) await dispose();
  }
}

export function host(): HTMLDivElement {
  const root = document.createElement("div");
  root.style.width = "720px";
  root.style.maxWidth = "100%";
  document.body.append(root);
  own(() => root.remove());
  return root;
}

export function element<T extends HTMLElement = HTMLElement>(root: HTMLElement, id: string): T {
  const result = root.querySelector<T>(`[data-testid="${id}"]`);
  if (!result) throw new Error(`Missing widget element: ${id}`);
  return result;
}

export function pointer(action: PointerAction): Promise<void> {
  return commands.waveformPointer(action);
}

export async function drag(surface: HTMLElement, duration: number, from: number, to: number, alt = false): Promise<void> {
  const rect = surface.getBoundingClientRect();
  const y = rect.y + rect.height * 0.6;
  await pointer({ action: "down", x: rect.x + (from / duration) * rect.width, y, alt });
  await pointer({ action: "move", x: rect.x + (to / duration) * rect.width, y, alt });
  await pointer({ action: "up", alt });
}

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Small deterministic PCM fixture: the audible band identifies the played source time. */
export function bandsFile(seconds = 6): File {
  const sampleRate = 48_000;
  const samples = Math.round(seconds * sampleRate);
  const bytes = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(bytes);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) {
    const time = i / sampleRate;
    const frequency = time < 2 ? 220 : time < 4 ? 440 : 880;
    view.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * frequency * time) * 0.25 * 32767), true);
  }
  return new File([bytes], "bands.wav", { type: "audio/wav" });
}
