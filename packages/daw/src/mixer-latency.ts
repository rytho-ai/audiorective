/** One routed connection for the solver: from a node's output to another node's input, or to the master when `to` is `null`. */
export type LatencyEdge = Readonly<{ id: string; from: string; to: string | null }>;

/** What the solver reads: each node's own processing latency in samples (a missing node counts 0) and the routing between them. The routing must be acyclic. */
export type LatencyGraph = Readonly<{ own: ReadonlyMap<string, number>; edges: readonly LatencyEdge[] }>;

/** The solve: `delays` holds the samples to add on each edge (by edge `id`), `total` how many samples the master output lags the timeline. */
export type LatencySolution = Readonly<{ delays: ReadonlyMap<string, number>; total: number }>;

/**
 * Align every path to the slowest one. A node's arrival is the latest output of the edges feeding it (0 with none), its output is arrival plus its own latency,
 * and each feeding edge delays by `arrival - output(source)`. The master (`to: null`) is the sink; `total` is its arrival. Pure: the same graph always gives the same solution.
 */
export function solveLatency({ own, edges }: LatencyGraph): LatencySolution {
  const incoming = new Map<string | null, LatencyEdge[]>();
  for (const edge of edges) {
    const list = incoming.get(edge.to);
    if (list) list.push(edge);
    else incoming.set(edge.to, [edge]);
  }
  const arrivals = new Map<string | null, number>();
  const arrival = (node: string | null): number => {
    const known = arrivals.get(node);
    if (known !== undefined) return known;
    let latest = 0;
    for (const edge of incoming.get(node) ?? []) latest = Math.max(latest, arrival(edge.from) + (own.get(edge.from) ?? 0));
    arrivals.set(node, latest);
    return latest;
  };
  const delays = new Map<string, number>();
  for (const edge of edges) delays.set(edge.id, arrival(edge.to) - (arrival(edge.from) + (own.get(edge.from) ?? 0)));
  return { delays, total: arrival(null) };
}
