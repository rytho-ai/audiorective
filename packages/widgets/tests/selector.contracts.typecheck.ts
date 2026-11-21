import type { WavePlayer } from "@audiorective/player";
import { mountWaveformSelector, type WaveformSelectorOptions } from "../src";

export function selectorContracts(root: HTMLElement, player: WavePlayer): void {
  const options = { player, controls: false, audition: false } satisfies WaveformSelectorOptions;
  const view = mountWaveformSelector(root, options);
  view.setZoom(4);
  view.setAmplitudeZoom(2);
  view.scrollTo(view.getViewport().duration / 2);
  const amplitude: number = view.getAmplitudeZoom();
  void amplitude;
  // @ts-expect-error Visibility is a boolean, not a second display-mode API.
  const invalidControls: WaveformSelectorOptions = { player, controls: "hidden" };
  void invalidControls;
  // @ts-expect-error Zoom factors are numeric.
  view.setZoom("4");
  // @ts-expect-error Source data remains owned by the player.
  view.setData(null);
  view.dispose();
}
