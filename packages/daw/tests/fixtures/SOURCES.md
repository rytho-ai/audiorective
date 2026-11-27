# Fixtures in this folder

Subfolders describe their own files (`*/SOURCES.md`). This page covers the files at the top level.

| File                   | Origin                                                                                                                                                                                                                                                                                                                       | Licence                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `mixer-reference.json` | Recorded by this repository's own `tests/mixer-equivalence.browser.test.ts` (with `RECORD = true`) from the hand-built GainNode/StereoPannerNode mixer strips at commit `c6a2f57`: offline renders of synthetic sine buffers generated in the test, stored as base64 Float32 PCM per solo scenario. No third-party material. | Written for this repository; MIT, the same licence as the repository |
