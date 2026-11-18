export type PadControl = Readonly<{ id: string; label: string; key?: string }>;
export type PadGridOptions = Readonly<{
  pads: readonly PadControl[];
  press(id: string): void | (() => void);
}>;

/** Keyboard and pointer input for borrowed pads. Each press owns its own release. */
export function mountPadGrid(root: HTMLElement, { pads, press }: PadGridOptions) {
  const doc = root.ownerDocument;
  const view = doc.createElement("div");
  view.className = "ar-pad-grid";
  const pointers = new Map<number, () => void>();
  const keys = new Map<string, () => void>();
  const empty = () => {};
  function releaseAll(): void {
    for (const release of pointers.values()) release();
    for (const release of keys.values()) release();
    pointers.clear();
    keys.clear();
  }
  for (const pad of pads) {
    const button = doc.createElement("button");
    button.type = "button";
    button.textContent = pad.label;
    button.dataset.padId = pad.id;
    if (pad.key) button.setAttribute("aria-keyshortcuts", pad.key.toLowerCase());
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      button.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, press(pad.id) ?? empty);
    });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
      button.addEventListener(type, (event) => {
        const pointerId = (event as PointerEvent).pointerId;
        pointers.get(pointerId)?.();
        pointers.delete(pointerId);
      });
    }
    button.addEventListener("click", (event) => {
      if (event.detail !== 0) return;
      const release = press(pad.id);
      release?.();
    });
    view.append(button);
  }

  view.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    const fallback =
      key === " " || key === "enter" ? (event.target as HTMLElement).closest<HTMLButtonElement>("[data-pad-id]")?.dataset.padId : undefined;
    const id = fallback ?? pads.find(({ key: binding }) => binding?.toLowerCase() === key)?.id;
    if (!id || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    if (!keys.has(key)) keys.set(key, press(id) ?? empty);
  });
  view.addEventListener("keyup", (event) => {
    const key = event.key.toLowerCase();
    keys.get(key)?.();
    keys.delete(key);
  });
  view.addEventListener("focusout", (event) => {
    const NodeClass = doc.defaultView?.Node;
    if (!NodeClass || !(event.relatedTarget instanceof NodeClass) || !view.contains(event.relatedTarget)) releaseAll();
  });
  root.append(view);
  return {
    destroy() {
      releaseAll();
      view.remove();
    },
  };
}
