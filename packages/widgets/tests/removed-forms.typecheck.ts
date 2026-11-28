// Compile-time only: `pnpm typecheck` fails if a removed form comes back.
// @ts-expect-error `attachClipGesture` is exported by `widgets/clip` (and the root), not by `widgets/arrangement`.
import { attachClipGesture as notInArrangement } from "../src/arrangement";

export const removedForms: unknown = notInArrangement;
