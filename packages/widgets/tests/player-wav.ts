/** A silent 8-bit mono PCM WAV of the given length, as a blob URL. Revoke it with URL.revokeObjectURL. */
export function silentWavUrl(seconds: number, sampleRate = 8000): string {
  const frames = Math.round(seconds * sampleRate);
  const bytes = new Uint8Array(44 + frames).fill(128, 44);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + frames, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true); // byte rate
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, frames, true);
  return URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
}
