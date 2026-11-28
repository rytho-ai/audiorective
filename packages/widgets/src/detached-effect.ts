import { effect as signalEffect, untracked } from "@audiorective/core";

/**
 * A widget's reactive binding lives until the widget is disposed. Detached from any effect running at mount, so a caller
 * that mounts a widget inside its own effect does not silently stop the widget's updates when that effect re-runs.
 */
export const effect = (run: () => void): (() => void) => untracked(() => signalEffect(run));
