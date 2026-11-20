---
title: Pad Bank
---

Sample hits with choke groups from `@audiorective/blocks/pads`. Part of [Blocks](./blocks.md).

## Pad Bank

`PadBank` plays sample hits and owns reversible same-group choke policy. Use it when a sequencer can edit or cancel a hit after the Clock has scheduled it, or when a future closed-hat hit must choke an open-hat hit only if that closed hit still exists. Ordinary one-shot pads without choke can keep using core `Sampler` and `Voice`.

```typescript
import { PadBank } from "@audiorective/blocks/pads";

const instruments = new PadBank(context, [
  { id: "open-hat", buffer: openHat, group: "hat", gate: true },
  { id: "closed-hat", buffer: closedHat, group: "hat" },
]);
instruments.output.connect(context.destination);
instruments.routePad("open-hat", hatFilter); // optional: this pad feeds `hatFilter` instead of the bank output; hatFilter is a node you own
const manual = instruments.trigger("open-hat"); // caller owns this event
const queued = instruments.trigger("closed-hat", 1, context.currentTime + 0.2);
queued?.cancel(); // removes both the hit and its future choke; manual keeps sounding
// Later: manual?.cancel(); instruments.destroy(); context.close();
```

```typescript
type PadSpec = Readonly<{ id: string; buffer: AudioBuffer; group?: string; gate?: boolean }>;
class PadBank {
  constructor(context: BaseAudioContext, pads: readonly PadSpec[]); // an OfflineAudioContext works
}
```

Pad IDs must be nonempty and unique. `group` names the choke group; `gate` is described below.

`trigger(id, velocity = 1, when = context.currentTime, options?: { pitch?: number; duration?: number })` returns an `PadHit` with idempotent `cancel()` / `stop()` and `onEnded(listener)`, or `null` for an unknown pad ID. Velocity clamps to 0..1; a past `when` plays now. `options.pitch` is in semitones and sets the playback rate to `2 ** (pitch / 12)`. `options.duration` (seconds) applies only to `gate: true` pads: the gate closes at `when + duration`, retractably like choke, so cancelling the hit before then keeps the earlier close from applying; one-shot pads ignore it and play to the end of their buffer. Later hits with a **different ID** in the same `group` choke earlier hits at their native audio start time, even if the later hit was scheduled first. Hits of the same ID may overlap.

**`gate` and choke.** Choke does not need `gate`: a later hit of another pad in the same `group` cuts an earlier hit whether the earlier pad is a one-shot (`gate` omitted or `false`) or a gate pad, so a one-shot open hat is choked by a later closed hat. `gate` changes what the hit does when nothing chokes it. A one-shot plays its buffer once and ends at the buffer's end; `options.duration` is ignored. A `gate: true` pad loops its buffer for as long as the gate stays open, until the hit is cancelled, choked, or closed by `options.duration`; pass a `duration` from the sequencer, or the hit never ends by itself. Use `gate: true` for sustained sounds (an open hat held until the next hit, a pad that must stop at the step length) and leave it off for drum one-shots.

Choke is carried by a per-event gain gate, so cancelling an unstarted hit retracts its future choke. A choke that already reached its deadline stays committed and cannot resurrect an earlier sound. The cleanup timer retires silent nodes; it does not time the audible cutoff.

**Per-pad routing.** Each pad owns a gain node that feeds the bank `output`. `routePad(id, destination: AudioNode | null)` sends that pad to a node you own instead (a filter, a send), and `routePad(id, null)` sends it back to `output`. Choke acts before the routing, so two pads in one `group` can feed different effects and still cut each other. A routed pad bypasses `params.volume`, which scales only the bank `output`. The bank owns its pad nodes and edges; you own every destination. `destroy()` disconnects only the bank's own nodes and leaves a destination connected to the rest of your graph. An unknown pad ID throws `Unknown pad.`

`assign(id, buffer)` replaces that pad's buffer, cancels its current and future hits, and retracts their future choke. `stopAll()` cancels every hit. `cells.activeEvents` is a read-only reactive count and `cells.pads` is the read-only list of current pad specs, which changes on `assign`; `params.volume` follows the normal schedulable `.value` / `$` contract. The block owns its nodes and event handles, while the caller owns output routing and the `AudioContext`. It has no polyphony cap or voice-stealing policy. For Clock-owned sequenced hits, pass the handle to `window.own(hit, when)` and call `clock.refresh()` after pattern edits (or let `refreshOnEdit` do it, see [Step Sequencer](./sequencer-advanced.md#edits-and-the-look-ahead)); manual hits remain unregistered. See [Clock](./clock.md#own-cancellable-events-when-transport-edits-must-cut-queued-sound).

## Common errors

| Message                                                                                          | Cause                                                     | Fix                                               |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------- |
| `Pad Bank pad IDs must be nonempty and unique.`                                                  | Empty or repeated pad ID                                  | Give each pad a stable unique ID.                 |
| `Pad hit time must be finite, non-negative seconds.` / `Pad hit velocity must be finite.`        | Invalid hit time or velocity                              | Use absolute audio seconds and a finite velocity. |
| `Pad hit pitch must be finite semitones.` / `Pad hit duration must be finite, positive seconds.` | Invalid `options.pitch` or `options.duration`             | Pass finite semitones and a duration above zero.  |
| `Unknown pad.`                                                                                   | `assign()` or `routePad()` received an ID not in the bank | Use a declared pad ID.                            |
| `PadBank is destroyed.`                                                                          | Trigger, assign or routePad after cleanup                 | Create a new block; `destroy()` is final.         |
