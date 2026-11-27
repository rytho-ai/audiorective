import { effect } from "alien-signals";
import { untracked } from "./Cell";
import { AudioProcessor } from "./AudioProcessor";
import { SchedulableParam } from "./SchedulableParam";

// AudioWorkletNode has unknowable latency, so it can never appear as a graph endpoint —
// only an AudioProcessor that declares its own latency can wrap one. NotWorklet only
// rejects a concrete AudioWorkletNode (or subtype); a naked `AudioNode` passes through
// unchanged, so the exclusion only bites once `defineGraph` infers each edge's concrete
// endpoint types (see `ValidateEdges` below).
export type NotWorklet<T> = T extends { port: MessagePort; parameters: AudioParamMap } ? never : T;

export type GraphSource = AudioNode | AudioProcessor; // AudioWorkletNode excluded via NotWorklet<T>
export type GraphSink = AudioNode | AudioProcessor | AudioParam | SchedulableParam;

export interface EdgeOptions {
  /** Zero-based source output port; defaults to 0. */
  output?: number;
  /** Zero-based destination input port; defaults to 0. */
  input?: number;
  /** Optional diagnostic text for this connection; does not affect routing. */
  label?: string;
}

export type GraphEdge = readonly [GraphSource, GraphSink] | readonly [GraphSource, GraphSink, EdgeOptions];
export type EdgeList = ReadonlyArray<GraphEdge | false | null | undefined>;

// A sink-position AudioProcessor must narrow `input` to a concrete AudioNode — the base
// class types it `AudioNode | undefined`, which fails the structural check below — so an
// output-only processor (or a bare AudioProcessor-typed reference) is rejected here rather
// than only at the `resolveTo` runtime throw.
type ValidateSink<T> = T extends AudioProcessor ? (T extends { input: AudioNode } ? T : never) : NotWorklet<T>;

// Rewrites each edge's inferred endpoint types through the checks above, so passing a
// concrete AudioWorkletNode, or a processor with no usable input, as either endpoint
// resolves that position to `never` and fails to typecheck.
type ValidateEdge<E> = E extends readonly [infer From, infer To, ...infer Rest] ? readonly [NotWorklet<From>, ValidateSink<To>, ...Rest] : E;
export type ValidateEdges<E extends EdgeList> = { [K in keyof E]: E[K] extends GraphEdge ? ValidateEdge<E[K]> : E[K] };

export interface GraphOptions {
  /** Audio context shared by every node in this graph. */
  context: BaseAudioContext;
  /** Enable automatic join-point latency compensation; defaults to true. */
  compensate?: boolean;
  /** Optional processor whose latency includes this graph's internal paths. */
  owner?: AudioProcessor;
  /**
   * Called with the handle after each solve completes. `AudioEngine` uses this to keep
   * `AudioEngine.latency` current; any caller can use it the same way to react to a fresh
   * solve — e.g. re-read `snapshot()`.
   */
  onSolve?: (handle: GraphHandle) => void;
}

export interface GraphHandle {
  /** Disconnects owned graph routes and compensation nodes; safe to call twice. */
  dispose(): void;
  /** Target arrival in samples at `node`'s output in the last solve; live compensation may still be crossfading. */
  arrivalOf(node: GraphSource): number;
  /** A point-in-time logical solve — nodes, edges and target compensation, excluding private handover routes. */
  snapshot(): GraphSnapshot;
  /**
   * The id `snapshot()` uses for `endpoint`, stable across solves as long as the
   * underlying object doesn't change. For an `AudioProcessor` this is the id of its
   * OUTPUT node — the node it appears as when it's a `from` in `snapshot()`'s edges; the
   * input side, when it differs, is reachable from there via a `"virtual"` edge.
   */
  idOf(endpoint: GraphSource | AudioParam): number;
  /**
   * Whether `from`'s output forward-connects to `to` in the last solve (following real
   * non-back-edge wires and virtual processor-internal wires). `false` when either side
   * didn't participate in the last solve.
   */
  reaches(from: GraphSource, to: GraphSource): boolean;
}

// Module-internal: `arrivalOf` throws this — never a bare `Error` — when the queried
// node didn't participate in the graph's last solve, so a caller distinguishing this
// specific condition (AudioEngine, translating it to `LatencyUnknownError`) doesn't
// have to catch-all and risk masking an unrelated bug. Not exported from index.ts.
export class NodeNotInSolveError extends Error {
  constructor() {
    super("defineGraph: node not present in the last solve");
    this.name = "NodeNotInSolveError";
  }
}

type Endpoint = AudioNode | AudioParam;

// One physical connection, keyed for diffing by identity + channel indices.
interface Wire {
  fromNode: AudioNode;
  to: Endpoint;
  output: number;
  input: number;
  label?: string;
}

export interface GraphSnapshot {
  /** Monotonically increasing diagnostic solve counter. */
  solveId: number;
  /** Snapshot of participating nodes; identifiers are local to the diagnostic graph. */
  nodes: {
    /** Numeric node identifier referenced by snapshot edges. */
    id: number;
    /** Node category: native Web Audio node or AudioProcessor. */
    kind: "native" | "processor";
    /** Human-readable diagnostic text; does not affect routing. */
    label: string;
    /** Declared processing delay in sample frames. */
    latency: number;
    /** Accumulated arrival delay in sample frames. */
    arrival: number;
  }[];
  /** Snapshot of connections, including virtual and feedback edges. */
  edges: {
    /** Numeric identifier of the source node in this snapshot. */
    from: number;
    /** Numeric identifier of the destination node in this snapshot. */
    to: number;
    /** Optional diagnostic text inherited from the connection. */
    label?: string;
    /** Connection category; back edges are excluded from forward delay solving. */
    kind: "audio" | "param" | "virtual" | "back";
    /** Additional alignment delay in sample frames; 0 when none is needed. */
    compensationSamples: number;
  }[];
}

interface GraphRegistration {
  owner?: AudioProcessor;
  sink: GraphSource;
}

// Engine-internal: maps every AudioProcessor that has appeared as a graph endpoint to
// every live graph handle it currently belongs to, so a caller can walk a processor to
// its solve state (e.g. for a devtools inspector) without the caller threading handles
// through, and so a
// processor wired into more than one graph keeps a resolvable entry for each — one
// graph disposing or dropping the processor only clears that graph's own registration.
// `sink` is a graph's own join point for path-latency queries — the owner's output for
// a processor-owned graph, or the context's destination for an engine-owned (ownerless)
// one.
export const _graphRegistry = new WeakMap<AudioProcessor, Map<GraphHandle, GraphRegistration>>();

// Errors identify an endpoint by its edge `label` when the caller gave one, else by the
// endpoint's constructor name.
const nameOf = (v: object, label?: string): string => label ?? v.constructor.name;

function assertNotWorklet(node: AudioNode, label?: string): void {
  if (typeof AudioWorkletNode !== "undefined" && node instanceof AudioWorkletNode) {
    throw new Error(
      `defineGraph: ${nameOf(node, label)} is a bare AudioWorkletNode — it has unknowable latency; wrap it in an AudioProcessor that declares latency`,
    );
  }
}

const resolveFrom = (v: GraphSource, label?: string): AudioNode => {
  if (v instanceof AudioProcessor) {
    const out = v.output;
    if (!out) throw new Error(`defineGraph: ${nameOf(v, label)} used as source has no output`);
    return out;
  }
  assertNotWorklet(v, label);
  return v;
};

const resolveTo = (v: GraphSink, label?: string): Endpoint => {
  if (v instanceof AudioProcessor) {
    const inp = v.input;
    if (!inp) throw new Error(`defineGraph: ${nameOf(v, label)} used as sink has no input`);
    return inp;
  }
  if (v instanceof SchedulableParam) return v.audioParam;
  if (v instanceof AudioParam) return v;
  assertNotWorklet(v, label);
  return v;
};

function connectWire(w: Wire): void {
  if (w.to instanceof AudioParam) w.fromNode.connect(w.to, w.output);
  else w.fromNode.connect(w.to, w.output, w.input);
}

function disconnectWire(w: Wire): void {
  try {
    if (w.to instanceof AudioParam) w.fromNode.disconnect(w.to, w.output);
    else w.fromNode.disconnect(w.to, w.output, w.input);
  } catch {
    // Already gone (node disposed elsewhere); the goal is the absence of the connection.
  }
}

function pushWire(map: Map<AudioNode, Wire[]>, key: AudioNode, wire: Wire): void {
  const arr = map.get(key);
  if (arr) arr.push(wire);
  else map.set(key, [wire]);
}

/** Time constant for compensation-route handovers; settle exactly after ten constants. */
const COMPENSATION_GATE = 0.003;

interface SolveResult {
  arrival: Map<AudioNode, number>;
  diffs: Map<Wire, number>;
  backEdges: Set<Wire>;
  forwardAdj: Map<AudioNode, AudioNode[]>;
}

// Longest-path latency solve over the resolved wire graph.
//
//  1. Back-edge detection: iterative DFS with white/gray/black coloring — an edge into a
//     gray (still-on-stack) node closes a cycle and is excluded from the rest of the solve.
//     A virtual edge (see below) is a processor's own internal path, never a feedback
//     loop, so it must never be the one excluded. Detection therefore runs on a graph
//     with each virtual edge's endpoints union-find–contracted into one node: any cycle
//     that only exists by way of a virtual edge collapses away, leaving a real edge (the
//     external feedback wire) to close the cycle and get excluded instead.
//  2. Topological order over the remaining (forward) edges — Kahn's algorithm.
//  3. arrival(n) = max over forward incoming wires of arrival(from) + nodeLatency(from);
//     a node with no forward incoming wire is an entry point, arrival 0.
//  4. Per-wire diff = arrival(n) − (arrival(from) + nodeLatency(from)): how many samples
//     that wire's branch lags the join it feeds.
//
// AudioParam sinks don't participate — they're not AudioNode join points. `virtualWires`
// stand in for a processor's invisible input→output path (see `apply`) and are always
// forward — they're excluded from back-edge detection's input graph entirely.
function solve(wires: Wire[], virtualWires: Wire[], nodeLatency: (n: AudioNode) => number, ownerInput: AudioNode | undefined): SolveResult {
  const nodes = new Set<AudioNode>();
  for (const w of wires) {
    if (w.to instanceof AudioParam) continue;
    nodes.add(w.fromNode);
    nodes.add(w.to);
  }
  for (const w of virtualWires) {
    nodes.add(w.fromNode);
    nodes.add(w.to as AudioNode);
  }

  const parent = new Map<AudioNode, AudioNode>();
  const find = (n: AudioNode): AudioNode => {
    let root = parent.get(n) ?? n;
    while (parent.get(root) && parent.get(root) !== root) root = parent.get(root)!;
    parent.set(n, root);
    return root;
  };
  const union = (a: AudioNode, b: AudioNode): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const v of virtualWires) union(v.fromNode, v.to as AudioNode);

  const contractedOutgoing = new Map<AudioNode, Wire[]>();
  const contractedNodes = new Set<AudioNode>();
  for (const w of wires) {
    if (w.to instanceof AudioParam) continue;
    const fromRoot = find(w.fromNode);
    contractedNodes.add(fromRoot);
    contractedNodes.add(find(w.to));
    pushWire(contractedOutgoing, fromRoot, w);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<AudioNode, number>();
  const backEdges = new Set<Wire>();
  for (const start of contractedNodes) {
    if (color.has(start)) continue;
    const stack: { node: AudioNode; edges: Wire[]; idx: number }[] = [{ node: start, edges: contractedOutgoing.get(start) ?? [], idx: 0 }];
    color.set(start, GRAY);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      if (frame.idx < frame.edges.length) {
        const w = frame.edges[frame.idx++]!;
        const to = find(w.to as AudioNode);
        const c = color.get(to) ?? WHITE;
        if (c === WHITE) {
          color.set(to, GRAY);
          stack.push({ node: to, edges: contractedOutgoing.get(to) ?? [], idx: 0 });
        } else if (c === GRAY) {
          backEdges.add(w);
        }
      } else {
        color.set(frame.node, BLACK);
        stack.pop();
      }
    }
  }

  const fwdOutgoing = new Map<AudioNode, Wire[]>();
  const fwdIncoming = new Map<AudioNode, Wire[]>();
  for (const w of wires) {
    if (w.to instanceof AudioParam || backEdges.has(w)) continue;
    pushWire(fwdOutgoing, w.fromNode, w);
    pushWire(fwdIncoming, w.to, w);
  }
  for (const w of virtualWires) {
    pushWire(fwdOutgoing, w.fromNode, w);
    pushWire(fwdIncoming, w.to as AudioNode, w);
  }

  const inDegree = new Map<AudioNode, number>();
  for (const n of nodes) inDegree.set(n, (fwdIncoming.get(n) ?? []).length);
  const queue: AudioNode[] = [];
  for (const n of nodes) if (inDegree.get(n) === 0) queue.push(n);
  const order: AudioNode[] = [];
  while (queue.length > 0) {
    const n = queue.shift()!;
    order.push(n);
    for (const w of fwdOutgoing.get(n) ?? []) {
      const to = w.to as AudioNode;
      const d = (inDegree.get(to) ?? 0) - 1;
      inDegree.set(to, d);
      if (d === 0) queue.push(to);
    }
  }

  const arrival = new Map<AudioNode, number>();
  for (const n of order) {
    if (n === ownerInput) {
      arrival.set(n, 0);
      continue;
    }
    const ins = fwdIncoming.get(n) ?? [];
    let max = 0;
    for (const w of ins) {
      const a = (arrival.get(w.fromNode) ?? 0) + nodeLatency(w.fromNode);
      if (a > max) max = a;
    }
    arrival.set(n, max);
  }

  const diffs = new Map<Wire, number>();
  for (const n of order) {
    const ins = fwdIncoming.get(n) ?? [];
    if (ins.length === 0) continue;
    const target = arrival.get(n) ?? 0;
    for (const w of ins) {
      const a = (arrival.get(w.fromNode) ?? 0) + nodeLatency(w.fromNode);
      diffs.set(w, target - a);
    }
  }

  const forwardAdj = new Map<AudioNode, AudioNode[]>();
  for (const [n, ws] of fwdOutgoing) {
    forwardAdj.set(
      n,
      ws.map((w) => w.to as AudioNode),
    );
  }

  return { arrival, diffs, backEdges, forwardAdj };
}

/**
 * Reactively wires `fn`'s declared edges into the graph, diffing against the
 * previous render so only added/removed connections touch the audio graph.
 */
export function defineGraph<const E extends EdgeList>(fn: () => readonly [...ValidateEdges<E>], options: GraphOptions): GraphHandle;
export function defineGraph(fn: () => EdgeList, options: GraphOptions): GraphHandle {
  const ctx = options.context;
  let current = new Map<string, Wire>();
  const ids = new WeakMap<object, number>();
  let nextId = 1;
  const idOf = (o: object) => ids.get(o) ?? (ids.set(o, nextId), nextId++);

  // Every audio wire has a stable gain route. Compensation changes add a fresh
  // delay route, warm its history, then crossfade; an audible delay is never retimed.
  interface RouteBranch {
    gate: GainNode;
    delay?: DelayNode;
    seconds: number;
    retire?: ReturnType<typeof setTimeout>;
  }
  interface CompRoute {
    wire: Wire;
    branches: Set<RouteBranch>;
    target: RouteBranch;
    fresh: boolean;
  }
  const compRoutes = new Map<string, CompRoute>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let disposed = false;
  let arrival = new Map<AudioNode, number>();
  let nodeOwner = new Map<AudioNode, AudioProcessor>();
  // Input node → owning processor, kept alongside `nodeOwner` (output node → processor)
  // so `snapshot()` can classify a processor's input node as "processor" too.
  let inputNodeOwner = new Map<AudioNode, AudioProcessor>();
  let lastVirtualWires: Wire[] = [];
  let lastBackEdges = new Set<Wire>();
  let lastDiffs = new Map<Wire, number>();
  let lastForwardAdj = new Map<AudioNode, AudioNode[]>();
  let solveId = 0;
  // Processors this graph currently owns an entry for in `_graphRegistry` — diffed each
  // render so a processor that leaves the edge list (or the graph itself disposes) has
  // its entry removed instead of going stale.
  let registeredProcessors = new Set<AudioProcessor>();

  function cancelRetirement(branch: RouteBranch): void {
    if (branch.retire === undefined) return;
    clearTimeout(branch.retire);
    timers.delete(branch.retire);
    branch.retire = undefined;
  }

  function removeBranch(route: CompRoute, branch: RouteBranch): void {
    cancelRetirement(branch);
    try {
      route.wire.fromNode.disconnect(branch.delay ?? branch.gate, route.wire.output);
    } catch {
      /* source already disposed */
    }
    branch.delay?.disconnect();
    branch.gate.disconnect();
    route.branches.delete(branch);
  }

  function branchFor(route: CompRoute, seconds: number, gain: number): RouteBranch {
    const gate = new GainNode(ctx, { gain });
    gate.gain.setValueAtTime(gain, ctx.currentTime);
    const delay = seconds > 0 ? new DelayNode(ctx, { delayTime: seconds, maxDelayTime: seconds }) : undefined;
    const branch: RouteBranch = { gate, delay, seconds };
    route.wire.fromNode.connect(delay ?? gate, route.wire.output);
    if (delay) delay.connect(gate);
    gate.connect(route.wire.to as AudioNode, 0, route.wire.input);
    route.branches.add(branch);
    return branch;
  }

  // Cleanup is not an audio event: native gain automation has already faded the
  // route to zero. Check the context clock so a suspended context cannot retire
  // an audible route early. This also avoids colliding OfflineAudioContext suspend
  // points with a processor's own edit scheduler.
  function retireAfter(route: CompRoute, branch: RouteBranch, when: number): void {
    cancelRetirement(branch);
    const check = () => {
      if (branch.retire !== undefined) timers.delete(branch.retire);
      branch.retire = undefined;
      if (disposed || !route.branches.has(branch)) return;
      if (ctx.state !== "closed" && ctx.currentTime < when) {
        arm();
      } else if (route.target !== branch) removeBranch(route, branch);
    };
    const arm = () => {
      branch.retire = setTimeout(check, Math.min(50, Math.max(1, (when - ctx.currentTime) * 1000 + 5)));
      timers.add(branch.retire);
    };
    arm();
  }

  function connectPhysical(key: string, wire: Wire): void {
    if (wire.to instanceof AudioParam || options.compensate === false) return connectWire(wire);
    const route: CompRoute = { wire, branches: new Set(), target: undefined!, fresh: true };
    route.target = branchFor(route, 0, 1);
    compRoutes.set(key, route);
  }

  function disconnectPhysical(key: string, wire: Wire): void {
    const route = compRoutes.get(key);
    if (!route) return disconnectWire(wire);
    for (const branch of [...route.branches]) removeBranch(route, branch);
    compRoutes.delete(key);
  }

  function spliceCompensation(wires: Map<string, Wire>, diffs: Map<Wire, number>): void {
    for (const [key, wire] of wires) {
      const route = compRoutes.get(key);
      if (!route) continue; // AudioParam edges keep their native connection.
      const seconds = Math.max(0, diffs.get(wire) ?? 0) / ctx.sampleRate;
      if (route.target.seconds !== seconds) {
        if (route.fresh || ctx.currentTime === 0) {
          // A new wire has no audible history to preserve. Initial compensation
          // is exact, including a graph assembled before offline rendering starts.
          for (const branch of [...route.branches]) removeBranch(route, branch);
          route.target = branchFor(route, seconds, 1);
        } else {
          const start = ctx.currentTime + seconds + (2 * 128) / ctx.sampleRate;
          const end = start + 10 * COMPENSATION_GATE;
          const next = branchFor(route, seconds, 0);
          route.target = next;
          for (const branch of route.branches) {
            if (branch === next) continue;
            branch.gate.gain.cancelAndHoldAtTime(start);
            branch.gate.gain.setTargetAtTime(0, start, COMPENSATION_GATE);
            branch.gate.gain.setValueAtTime(0, end);
            // A rapid subsequent retime can extend a partially faded route.
            // Replace its cleanup rather than cutting it at the old fade end.
            retireAfter(route, branch, end);
          }
          next.gate.gain.setValueAtTime(0, start);
          next.gate.gain.setTargetAtTime(1, start, COMPENSATION_GATE);
          next.gate.gain.setValueAtTime(1, end);
        }
      }
      route.fresh = false;
    }
  }

  const handle: GraphHandle = {
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      for (const [key, w] of current) disconnectPhysical(key, w);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      current = new Map();
      arrival = new Map();
      nodeOwner = new Map();
      inputNodeOwner = new Map();
      lastVirtualWires = [];
      lastBackEdges = new Set();
      lastDiffs = new Map();
      lastForwardAdj = new Map();
      for (const proc of registeredProcessors) {
        _graphRegistry.get(proc)?.delete(handle);
      }
      registeredProcessors = new Set();
    },
    arrivalOf(node: GraphSource): number {
      const resolved = node instanceof AudioProcessor ? node.output : node;
      if (!resolved || !arrival.has(resolved)) {
        throw new NodeNotInSolveError();
      }
      return (arrival.get(resolved) ?? 0) + (nodeOwner.get(resolved)?.latency.value ?? 0);
    },
    snapshot(): GraphSnapshot {
      const nodes = new Map<number, GraphSnapshot["nodes"][number]>();
      const edges: GraphSnapshot["edges"] = [];
      const nodeLatency = (n: AudioNode) => nodeOwner.get(n)?.latency.value ?? 0;

      const registerNode = (n: AudioNode): number => {
        const id = idOf(n);
        if (nodes.has(id)) return id;
        const proc = nodeOwner.get(n) ?? inputNodeOwner.get(n);
        nodes.set(id, {
          id,
          kind: proc ? "processor" : "native",
          label: (proc ?? n).constructor.name,
          latency: nodeLatency(n),
          arrival: arrival.get(n) ?? 0,
        });
        return id;
      };

      for (const w of current.values()) {
        const fromId = registerNode(w.fromNode);
        if (w.to instanceof AudioParam) {
          const toId = idOf(w.to);
          if (!nodes.has(toId)) {
            nodes.set(toId, { id: toId, kind: "native", label: "AudioParam", latency: 0, arrival: 0 });
          }
          edges.push({ from: fromId, to: toId, label: w.label, kind: "param", compensationSamples: 0 });
          continue;
        }
        const toId = registerNode(w.to);
        const kind = lastBackEdges.has(w) ? "back" : "audio";
        const compensationSamples = kind === "audio" && options.compensate !== false ? (lastDiffs.get(w) ?? 0) : 0;
        edges.push({ from: fromId, to: toId, label: w.label, kind, compensationSamples });
      }

      for (const w of lastVirtualWires) {
        const fromId = registerNode(w.fromNode);
        const toId = registerNode(w.to as AudioNode);
        edges.push({ from: fromId, to: toId, kind: "virtual", compensationSamples: 0 });
      }

      return { solveId, nodes: [...nodes.values()], edges };
    },
    idOf(endpoint: GraphSource | AudioParam): number {
      if (endpoint instanceof AudioProcessor) {
        const out = endpoint.output;
        if (!out) throw new Error(`defineGraph: ${endpoint.constructor.name} has no output`);
        return idOf(out);
      }
      return idOf(endpoint);
    },
    reaches(from: GraphSource, to: GraphSource): boolean {
      const fromNode = from instanceof AudioProcessor ? from.output : from;
      const toNode = to instanceof AudioProcessor ? to.output : to;
      if (!fromNode || !toNode) return false;
      if (fromNode === toNode) return true;
      const visited = new Set<AudioNode>([fromNode]);
      const stack: AudioNode[] = [fromNode];
      while (stack.length > 0) {
        const n = stack.pop()!;
        for (const next of lastForwardAdj.get(n) ?? []) {
          if (next === toNode) return true;
          if (!visited.has(next)) {
            visited.add(next);
            stack.push(next);
          }
        }
      }
      return false;
    },
  };

  const apply = (edges: EdgeList) => {
    const next = new Map<string, Wire>();
    // Latency is attributed only at the node that is a processor's OUTPUT — the node
    // that is read as some wire's `from`. A sink-side registration would wrongly charge
    // the processor's latency to its input node (and race with whichever processor last
    // claims a shared node), so `to instanceof AudioProcessor` never writes here.
    const owners = new Map<AudioNode, AudioProcessor>();
    // Every processor seen as an edge endpoint, input/output node pair — used below to
    // add a virtual `input → output` edge so arrival chains across it even though the
    // real connection lives inside the processor's own (separate) defineGraph.
    const seenProcessors = new Set<AudioProcessor>();
    // Processors that actually join the node solve (as opposed to a `from` whose only
    // edge feeds an AudioParam, which never becomes an arrival node) — the registry
    // should only ever answer for a processor whose path latency the solve can compute.
    const memberProcessors = new Set<AudioProcessor>();
    const sink: GraphSource = options.owner ?? options.context.destination;
    for (const e of edges) {
      if (!e) continue;
      const [from, to, opts] = e;
      const fromNode = resolveFrom(from, opts?.label);
      const toEndpoint = resolveTo(to, opts?.label);
      const isParamSink = toEndpoint instanceof AudioParam;
      if (from instanceof AudioProcessor) {
        owners.set(fromNode, from);
        seenProcessors.add(from);
        if (!isParamSink) memberProcessors.add(from);
      }
      if (to instanceof AudioProcessor) {
        seenProcessors.add(to);
        memberProcessors.add(to);
      }
      const wire: Wire = { fromNode, to: toEndpoint, output: opts?.output ?? 0, input: opts?.input ?? 0, label: opts?.label };
      next.set(`${idOf(wire.fromNode)}>${idOf(wire.to)}@${wire.output},${wire.input}`, wire);
    }

    for (const proc of memberProcessors) {
      let regs = _graphRegistry.get(proc);
      if (!regs) {
        regs = new Map();
        _graphRegistry.set(proc, regs);
      }
      regs.set(handle, { owner: options.owner, sink });
    }
    for (const proc of registeredProcessors) {
      if (memberProcessors.has(proc)) continue;
      // Only this graph's own registration is removed — another graph the processor
      // still belongs to keeps its own entry.
      _graphRegistry.get(proc)?.delete(handle);
    }
    registeredProcessors = memberProcessors;

    for (const [k, w] of current) if (!next.has(k)) disconnectPhysical(k, w);
    for (const [k, w] of next) if (!current.has(k)) connectPhysical(k, w);
    current = next;
    nodeOwner = owners;

    // A processor whose input and output are different nodes has no wire in *this*
    // graph connecting them — that path lives inside its own defineGraph. Without a
    // stand-in edge, its output node would look like an entry point (arrival 0) and
    // discard whatever arrival built up before its input. The virtual edge carries zero
    // latency itself (nodeLatency(input) is 0 — inputs are never registered as owners
    // above), so it only forwards arrival; the processor's own latency is still charged
    // once, at its output, by whichever wire reads from it next.
    const virtualWires: Wire[] = [];
    const inputOwners = new Map<AudioNode, AudioProcessor>();
    for (const proc of seenProcessors) {
      const input = proc.input;
      const output = proc.output;
      if (input) inputOwners.set(input, proc);
      if (input && output && input !== output) {
        virtualWires.push({ fromNode: input, to: output, output: 0, input: 0 });
      }
    }

    // Reading `.latency.value` here (via nodeLatency, inside solve) is what makes this
    // effect re-run when any member processor's latency changes.
    const nodeLatency = (n: AudioNode) => owners.get(n)?.latency.value ?? 0;
    const solved = solve([...current.values()], virtualWires, nodeLatency, options.owner?.input);
    arrival = solved.arrival;
    inputNodeOwner = inputOwners;
    lastVirtualWires = virtualWires;
    lastBackEdges = solved.backEdges;
    lastDiffs = solved.diffs;
    lastForwardAdj = solved.forwardAdj;
    solveId++;

    if (options.compensate !== false) {
      spliceCompensation(current, solved.diffs);
    }

    // A processor with no declared latency gets it derived from its own graph's solve.
    // The comparison below reads owner.latency.value, which subscribes this same effect
    // to it — an unconditional write would retrigger it forever. The no-op guard breaks
    // that loop, and lets an outer graph (which reads this processor's latency as a
    // `from`-node) converge after one extra re-run instead of looping too.
    if (options.owner && !options.owner.declaredLatency) {
      const outNode = options.owner.output;
      if (outNode) {
        const derived = (arrival.get(outNode) ?? 0) + nodeLatency(outNode);
        if (options.owner.latency.value !== derived) {
          options.owner.latency.value = derived;
        }
      }
    }

    options.onSolve?.(handle);
  };

  const stop = untracked(() => effect(() => apply(fn())));

  return handle;
}
