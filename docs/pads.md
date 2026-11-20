---
title: Pad Bank
---

Sound hits with choke groups from `@audiorective/pads`.

## Pad Bank

`PadBank` plays named pads that each play their own `Sound` (a note name, a buffer or a sound factory) and owns reversible same-group choke policy. Use it when a sequencer can edit or cancel a hit after the Clock has scheduled it, or when a future closed-hat hit must choke an open-hat hit only if that closed hit still exists. Independent one-shot pads without choke can keep using core `Sampler`; both take the same `Sound` and the same `PlayOptions`.

```typescript
import { PadBank } from "@audiorective/pads";

const instruments = new PadBank(context, [
  { id: "open-hat", sound: openHat, group: "hat" },
  { id: "closed-hat", sound: closedHat, group: "hat" },
]);
instruments.connect(context.destination);
instruments.routePad("open-hat", hatFilter); // optional: this pad feeds `hatFilter` instead of the bank output; hatFilter is a node you own
const manual = instruments.trigger("open-hat"); // caller owns this voice
const queued = instruments.trigger("closed-hat", { when: context.currentTime + 0.2 });
queued?.stop(); // removes both the hit and its future choke; manual keeps sounding
// Later: manual?.stop(); instruments.dispose(); context.close();
```

```typescript
type PadSpec = Readonly<{ id: string; sound: Sound; group?: string }>;
type PadBankOptions = Readonly<{ release?: number; signal?: AbortSignal }>;
class PadBank {
  constructor(context: BaseAudioContext, pads: readonly PadSpec[], options?: PadBankOptions); // an OfflineAudioContext works
  trigger(id: string, options?: PlayOptions): Voice | null;
  assign(id: string, sound: Sound): void;
  stopAll(when?: number): void;
}
```

Pad IDs must be nonempty and unique. `group` names the choke group. `release` (default 0.005 s) is the fade of a cut or stopped voice, and aborting `signal` calls `dispose()`.

`trigger(id, { velocity, when, pitch })` returns a core `Voice` (`stop(when?)` and `playing`), or `null` for an unknown pad ID. Velocity clamps to 0..1 and is applied once; a past `when` plays now; `pitch` is semitones, which a buffer follows as playback rate and a factory reads from `hit.pitch`. A hit is held until its sound ends or the voice is stopped: a buffer plays to its end, a factory returns its own `duration` or sounds until `stop`. Non-finite values throw the `Sound hit needs ...` errors listed in [Core](./core.md#common-errors).

**Choke.** A hit in a choke group cuts every sounding voice of the pads in the same `group`, its own pad included, with the bank's `release` fade, at its own native audio start time, even if it was scheduled first. Pads without a `group` layer freely, whatever their sound. A factory pad is choked the same way as a sample pad.

**Stopping.** `voice.stop()` with no time or a past time releases the voice now. `voice.stop(when)` schedules the release for `when` and is retractable like choke; stopping a hit before it starts drops it and removes its choke.

Choke is carried by a per-event gain gate, so stopping an unstarted hit retracts its future choke. A choke that already reached its deadline stays committed and cannot resurrect an earlier sound. The cleanup timer retires silent nodes; it does not time the audible cutoff.

**Per-pad routing.** Each pad owns a gain node that feeds the bank `output`. `routePad(id, destination: AudioNode | null)` sends that pad to a node you own instead (a filter, a send), and `routePad(id, null)` sends it back to `output`. Choke acts before the routing, so two pads in one `group` can feed different effects and still cut each other. A routed pad bypasses `params.volume`, which scales only the bank `output`. The bank owns its pad nodes and edges; you own every destination. `dispose()` disconnects only the bank's own nodes and leaves a destination connected to the rest of your graph. An unknown pad ID throws `Unknown pad.`

`assign(id, sound)` replaces that pad's sound, releases its current and future hits, and retracts their future choke. `stopAll(when?)` releases every voice. `cells.activeVoices` is a read-only reactive count of voices sounding or scheduled and `cells.pads` is the read-only list of current pad specs, which changes on `assign`; `params.volume` follows the normal schedulable `.value` / `$` contract. `PadBank` owns its nodes and voices, while the caller owns output routing and the `AudioContext`. It has no polyphony cap or voice-stealing policy. For Clock-owned sequenced hits, wrap the voice as a `CancellableEvent` and pass it to `window.own(event, when)`, then call `clock.refresh()` after pattern edits (a `StepSequencer` attached with `clock.attach` re-queues itself, see [Step Sequencer](./sequencer.md#layer-4-hooks)); manual hits remain unregistered. See [Clock](./clock.md#own-cancellable-events-when-transport-edits-must-cut-queued-sound).

## Common errors

| Message                                         | Cause                                                     | Fix                                         |
| ----------------------------------------------- | --------------------------------------------------------- | ------------------------------------------- |
| `Pad Bank pad IDs must be nonempty and unique.` | Empty or repeated pad ID                                  | Give each pad a stable unique ID.           |
| `Unknown pad.`                                  | `assign()` or `routePad()` received an ID not in the bank | Use a declared pad ID.                      |
| `PadBank is disposed.`                          | Trigger, assign or routePad after cleanup                 | Create a new PadBank; `dispose()` is final. |
