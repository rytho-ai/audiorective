/** A copy of `buffer` with every channel's samples in reverse order. */
export function reverseBuffer(buffer: AudioBuffer): AudioBuffer {
  const out = new AudioBuffer({
    numberOfChannels: buffer.numberOfChannels,
    length: buffer.length,
    sampleRate: buffer.sampleRate,
  });
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c).slice();
    data.reverse();
    out.copyToChannel(data, c);
  }
  return out;
}
