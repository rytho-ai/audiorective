import { cell, untracked, type Cell } from "./Cell";
import { defineGraph } from "./graph";
import type { EdgeList, GraphEdge, GraphHandle, GraphSink, GraphSource } from "./graph";

/**
 * Edges made by `AudioProcessor.connect`, solved as one latency graph per AudioContext.
 * Joins inside this graph are compensated like any `defineGraph` join, and the graph answers
 * `AudioEngine.getPathLatency` and feeds `AudioEngine.latency` for the engine that owns the context.
 */
interface Hub {
  edges: Cell<readonly GraphEdge[]>;
  handle: GraphHandle;
  listeners: Set<(handle: GraphHandle) => void>;
}

const hubs = new WeakMap<BaseAudioContext, Hub>();

function hubFor(context: BaseAudioContext): Hub {
  let hub = hubs.get(context);
  if (hub) return hub;
  const edges = cell<readonly GraphEdge[]>([]);
  const listeners = new Set<(handle: GraphHandle) => void>();
  // Built detached from any running effect, so a caller's re-run never disposes the shared graph.
  const handle = untracked(() =>
    defineGraph(() => edges.value as EdgeList as never, {
      context,
      onSolve: (h) => {
        for (const listener of [...listeners]) listener(h);
      },
    }),
  );
  hub = { edges, handle, listeners };
  hubs.set(context, hub);
  return hub;
}

/** Adds `from → to` to the context's connection graph unless the identical edge exists. */
export function addConnection(context: BaseAudioContext, from: GraphSource, to: GraphSink, output: number, input: number): void {
  const hub = hubFor(context);
  const current = untracked(() => hub.edges.value);
  for (const e of current) {
    if (e[0] === from && e[1] === to && (e[2]?.output ?? 0) === output && (e[2]?.input ?? 0) === input) return;
  }
  hub.edges.value = [...current, [from, to, { output, input }] as const];
}

/** Removes the connection graph's edges that match `match`. */
export function removeConnections(context: BaseAudioContext, match: (from: GraphSource, to: GraphSink) => boolean): void {
  const hub = hubs.get(context);
  if (!hub) return;
  const current = untracked(() => hub.edges.value);
  const next = current.filter((e) => !match(e[0], e[1]));
  if (next.length !== current.length) hub.edges.value = next;
}

/** Calls `listener` after each solve of the context's connection graph, and once now. Returns a stop function. */
export function watchConnections(context: BaseAudioContext, listener: (handle: GraphHandle) => void): () => void {
  const hub = hubFor(context);
  hub.listeners.add(listener);
  listener(hub.handle);
  return () => {
    hub.listeners.delete(listener);
  };
}
