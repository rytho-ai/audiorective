/** Combine dry and wet in the complex plane, then return magnitude and phase. */
export function mixFrequencyResponse(magnitudes: Float32Array, phases: Float32Array, wet: number, stages = 1): void {
  for (let index = 0; index < magnitudes.length; index++) {
    const amplitude = wet * magnitudes[index] ** stages;
    const phase = phases[index] * stages;
    const real = 1 - wet + amplitude * Math.cos(phase);
    const imaginary = amplitude * Math.sin(phase);
    magnitudes[index] = Math.hypot(real, imaginary);
    phases[index] = Math.atan2(imaginary, real);
  }
}
