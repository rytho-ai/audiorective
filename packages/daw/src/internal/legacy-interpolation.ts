import type { Element } from "@xmldom/xmldom";
import { arrivalShapes, type PointShape } from "./point-shape";

/**
 * The `audiorective/state.json` version from which a file's point `interpolation` means how the value ARRIVES at the point (what Bitwig Studio
 * reads and writes). Builds that wrote an earlier version used the point's own model `shape`, how the value LEAVES it, for track volume automation
 * and clip gain curves. A file without an Audiorective sidecar (another application's file) always uses the arriving meaning.
 */
export const ARRIVAL_STATE_VERSION = 4;

/** Whether a sidecar of this version was written with the leaving meaning of `interpolation`. */
export const writesLeavingShapes = (version: number): boolean => version < ARRIVAL_STATE_VERSION;

const elementsOf = (parent: Element, tag: string): Element[] => {
  const out: Element[] = [];
  for (let node = parent.firstChild; node; node = node.nextSibling)
    if (node.nodeType === 1 && (node as Element).tagName === tag) out.push(node as Element);
  return out;
};

/**
 * Rewrite, in the opened document only, the volume automation and clip gain curves of a file an earlier Audiorective build wrote (leaving meaning)
 * to the arriving meaning, so the one reader and the one patch writer see a single convention. Nothing in the file on disk changes until a save.
 * Only the curves that build wrote are touched: a `Points` whose `Target` is a parameter (volume) or the `gain` expression. Returns how many curves.
 */
export function migrateLeavingToArrival(root: Element): number {
  let curves = 0;
  for (const points of Array.from(root.getElementsByTagName("Points"))) {
    const target = elementsOf(points, "Target")[0];
    if (!target || !(target.hasAttribute("parameter") || target.getAttribute("expression") === "gain")) continue;
    const raw = elementsOf(points, "RealPoint");
    if (raw.length < 2) continue;
    const shapes = raw.map((point): PointShape => (point.getAttribute("interpolation") === "hold" ? "hold" : "linear"));
    const arrival = arrivalShapes(shapes.map((shape) => ({ shape })));
    raw.forEach((point, i) => {
      if (point.hasAttribute("interpolation")) point.setAttribute("interpolation", arrival[i]);
    });
    curves++;
  }
  return curves;
}
