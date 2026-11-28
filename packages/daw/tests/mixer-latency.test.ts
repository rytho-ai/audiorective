import { describe, expect, it } from "vitest";
import { solveLatency, type LatencyEdge } from "../src/mixer-latency";

const solve = (own: Record<string, number>, edges: LatencyEdge[]) => solveLatency({ own: new Map(Object.entries(own)), edges });
const out = (from: string): LatencyEdge => ({ id: `${from}>`, from, to: null });
const to = (from: string, bus: string, kind = ""): LatencyEdge => ({ id: `${from}>${kind}${bus}`, from, to: bus });

describe("solveLatency", () => {
  it("adds nothing when no track is latent", () => {
    const { delays, total } = solve({ a: 0, b: 0, bus: 0 }, [out("a"), to("b", "bus"), out("bus")]);
    expect([...delays.values()]).toEqual([0, 0, 0]);
    expect(total).toBe(0);
  });

  it("delays the other track's output when one of two is latent", () => {
    const { delays, total } = solve({ a: 256, b: 0 }, [out("a"), out("b")]);
    expect(delays.get("a>")).toBe(0);
    expect(delays.get("b>")).toBe(256);
    expect(total).toBe(256);
  });

  it("aligns direct tracks beside a latent bus", () => {
    const { delays, total } = solve({ a: 0, b: 0, bus: 300 }, [to("a", "bus"), out("bus"), out("b")]);
    expect(delays.get("a>bus")).toBe(0);
    expect(delays.get("bus>")).toBe(0);
    expect(delays.get("b>")).toBe(300);
    expect(total).toBe(300);
  });

  it("aligns a send into a latent bus with the direct track", () => {
    // `a` feeds the master directly and also sends into a bus that is 200 late; the bus outputs to the master.
    const { delays, total } = solve({ a: 0, bus: 200 }, [out("a"), to("a", "bus", "send:"), out("bus")]);
    expect(delays.get("a>send:bus")).toBe(0);
    expect(delays.get("a>")).toBe(200);
    expect(delays.get("bus>")).toBe(0);
    expect(total).toBe(200);
  });

  it("carries latency along a chain of buses", () => {
    const { delays, total } = solve({ track: 100, bus1: 50, bus2: 25, other: 0 }, [
      to("track", "bus1"),
      to("bus1", "bus2"),
      out("bus2"),
      out("other"),
    ]);
    expect(delays.get("track>bus1")).toBe(0);
    expect(delays.get("bus1>bus2")).toBe(0);
    expect(delays.get("bus2>")).toBe(0);
    expect(delays.get("other>")).toBe(175);
    expect(total).toBe(175);
  });

  it("delays the faster inputs of one bus to the slowest", () => {
    const { delays, total } = solve({ a: 100, b: 40, c: 0, bus: 10 }, [to("a", "bus"), to("b", "bus"), to("c", "bus"), out("bus")]);
    expect(delays.get("a>bus")).toBe(0);
    expect(delays.get("b>bus")).toBe(60);
    expect(delays.get("c>bus")).toBe(100);
    expect(total).toBe(110);
  });

  it("treats a node with no incoming edge as arriving at 0 and an unlisted node as 0 latency", () => {
    const { delays, total } = solve({ a: 5 }, [out("a"), out("ghost")]);
    expect(delays.get("a>")).toBe(0);
    expect(delays.get("ghost>")).toBe(5);
    expect(total).toBe(5);
  });

  it("has no total without edges", () => {
    expect(solve({}, []).total).toBe(0);
  });
});
