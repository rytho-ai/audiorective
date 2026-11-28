# Compressed audio test files

Generated for this repository (licence: the same as the repository) for `tests/dawproject-compressed-audio.test.ts` and `.browser.test.ts`. Each file is a 1 s recording whose only content is a short click (24 samples, loudest at the first) at exactly 0.5 s (sample 22 050 at 44.1 kHz, 24 000 at 48 kHz), written as 16-bit WAV by a short Python `wave` script, then encoded with ffmpeg 6.1.1 (`6.1.1-3ubuntu5+esm15`, Ubuntu 24.04), whose encoders report `Lavc60.31.102 libvorbis`, `Lavc60.31.102 libopus` and `Lavf60.16.100` (FLAC, MP3 container).

| File                  | Command                                                       | Format                                           | Bytes  |
| --------------------- | ------------------------------------------------------------- | ------------------------------------------------ | ------ |
| `click.ogg`           | `ffmpeg -i v44.wav -c:a libvorbis -q:a 2 click.ogg`           | Ogg Vorbis, 44.1 kHz, stereo                     | 4 182  |
| `click.flac`          | `ffmpeg -i f48.wav -c:a flac click.flac`                      | FLAC, 48 kHz, mono                               | 9 128  |
| `click.mp3`           | `ffmpeg -i m44.wav -c:a libmp3lame -b:a 128k click.mp3`       | MP3, 44.1 kHz, mono, with LAME/Xing gapless tag  | 17 180 |
| `click-nogapless.mp3` | `ffmpeg -i m44.wav -c:a libmp3lame -b:a 128k -write_xing 0 …` | the same MP3 without the Xing/LAME header        | 16 763 |
| `click.opus`          | `ffmpeg -i o48.wav -c:a libopus -b:a 64k click.opus`          | Opus in Ogg, 48 kHz, mono (pre-skip 312 samples) | 2 831  |
| `broken.ogg`          | 300 random bytes (`head -c 300 /dev/urandom`)                 | not audio: the browser cannot decode it          | 300    |

`compressed-audio.dawproject` is built from them by `make-project.mjs` (run `node make-project.mjs` from `packages/daw`; needs `fflate`): tempo 120 BPM, five audio tracks in the structure a PreSonus Studio One 7 export has (a master bus `Track`, `Clips` in beats), the Ogg clip in Studio One's nested form (an outer `Clip` around a `Clips` with one `Clip` whose `Warps` hold the `Audio`) and the others in the plain form; the FLAC clip plays the window 0.25 s to 0.75 s of its file. `click-nogapless.mp3` is not in the project: the browser test swaps it for `audio/click.mp3` to measure the decoder delay of an MP3 with no gapless header.

Measured with this repository's Chromium (Playwright 1.58): at 48 kHz every click of the four formats lands on exactly the expected frame (offset 0); the MP3 without the gapless header lands 1 203 frames late, which is 1 105 samples at 44.1 kHz (the LAME encoder delay of 576 plus the 529-sample decoder delay).
