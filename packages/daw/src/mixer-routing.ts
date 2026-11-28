import type { ProjectTrack } from "./model";

function destinations(track: ProjectTrack): string[] {
  const { outputBusId, sends } = track.routing;
  return [...(outputBusId === null ? [] : [outputBusId]), ...sends.filter(({ gain }) => gain > 0).map(({ busId }) => busId)];
}

/** Include the routes that carry soloed tracks and the inputs needed to hear a soloed bus. */
export function soloRouting(tracks: readonly ProjectTrack[]) {
  const byId = new Map(tracks.map((track) => [track.id, track]));
  const solo = tracks.filter((track) => track.solo);
  const downstream = new Set<string>();
  function walk(track: ProjectTrack): void {
    if (downstream.has(track.id)) return;
    downstream.add(track.id);
    for (const id of destinations(track)) walk(byId.get(id)!);
  }
  for (const track of solo) walk(track);
  const upstream = new Map<string, boolean>();
  function needsInput(track: ProjectTrack): boolean {
    let needed = upstream.get(track.id);
    if (needed === undefined) {
      needed = track.solo || destinations(track).some((id) => needsInput(byId.get(id)!));
      upstream.set(track.id, needed);
    }
    return needed;
  }
  return {
    strip: (track: ProjectTrack) => !solo.length || downstream.has(track.id) || needsInput(track),
    edge: (track: ProjectTrack, target: string | null) =>
      !solo.length || downstream.has(track.id) || (target !== null && needsInput(byId.get(target)!)),
  };
}
