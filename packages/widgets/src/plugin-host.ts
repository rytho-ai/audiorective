/** Attachment-scoped cleanup shared by time-based waveform and piano-roll plugins.
 * Reads: ./types. Widgets supply geometry; this host owns plugin registration and disposal.
 */
import type { PluginAttachment, Unsubscribe, WaveformPlugin, WaveformPluginContext } from "./types";

type PluginScope = { isActive(): boolean; own(dispose: Unsubscribe): Unsubscribe };

export function createPluginHost(name: "waveform" | "piano roll", contextFor: (scope: PluginScope) => WaveformPluginContext) {
  const attachments = new Map<WaveformPlugin, PluginAttachment>();
  const title = name[0].toUpperCase() + name.slice(1);
  let destroyed = false;
  const runCleanup = (dispose: Unsubscribe) => {
    try {
      dispose();
    } catch (error) {
      console.error(`${title} plugin cleanup failed:`, error);
    }
  };
  return {
    attach(plugin: WaveformPlugin): PluginAttachment {
      if (destroyed) throw new Error(`${title} is destroyed.`);
      if (attachments.has(plugin)) throw new Error(`Plugin is already attached to this ${name}.`);
      let active = true;
      const cleanups = new Set<Unsubscribe>();
      const own = (dispose: Unsubscribe): Unsubscribe => {
        if (!active) {
          runCleanup(dispose);
          return () => {};
        }
        let live = true;
        const wrapped = () => {
          if (!live) return;
          live = false;
          cleanups.delete(wrapped);
          runCleanup(dispose);
        };
        cleanups.add(wrapped);
        return wrapped;
      };
      let pluginDispose: Unsubscribe | undefined;
      const attachment: PluginAttachment = {
        destroy() {
          if (!active) return;
          active = false;
          attachments.delete(plugin);
          if (pluginDispose) runCleanup(pluginDispose);
          for (const dispose of [...cleanups]) dispose();
        },
      };
      attachments.set(plugin, attachment);
      try {
        const result = plugin.attach(contextFor({ isActive: () => active, own }));
        const dispose = typeof result === "function" ? result : result ? () => result.destroy() : undefined;
        // attach() can synchronously destroy the widget before returning a disposer.
        if (active) pluginDispose = dispose;
        else if (dispose) runCleanup(dispose);
      } catch (error) {
        attachment.destroy();
        throw error;
      }
      return attachment;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const attachment of [...attachments.values()]) attachment.destroy();
    },
  };
}
