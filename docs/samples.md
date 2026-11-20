---
title: Sample Library
---

Imported sample storage and previews from `@audiorective/samples`.

## Sample Library

`SampleLibrary` owns queued File decoding, byte accounting and an audition voice built on core `BufferPlayer`. Create it with the caller's `AudioContext`, connect `library.output` to an audition route and pass Files to `importFiles(files)`. The result contains row IDs in input order. A removed pending import resolves to `null`. Inspect `library.state.value.rows` for per-file readiness and decoding errors. `state` is the only store of rows, `decodedBytes`, `previewId` and `previewPlaying`; each change commits in one write. `preview(id)` is safe to call from inside an effect.

In a secure browser context, identical file bytes share a row based on a content hash even when the names differ. Import is sequential. The default file limit is 64 MiB and the default retained PCM limit is 256 MiB. Pass `maxFileBytes` and `maxDecodedBytes` to change those limits. The PCM limit counts the library's decoded buffers, including removed samples with outstanding leases.

Use `library.preview(id)` to audition a ready sample independently of the transport and `stopPreview()` to stop. Use `acquire(id)` to borrow its decoded `AudioBuffer` and `release()` when finished. Treat borrowed PCM as read-only. Removing a row stops its audition and leaves the leased samples available. Disposeing the library clears rows and stops preview. Outstanding leases remain valid until released. Projects can copy leased samples into their own clips with `Project.addAudioClip()`.

## Common errors

| Sample Library message                                      | Fix                                                                           |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `Sample Library byte limits must be non-negative.`          | Supply non-negative byte limits.                                              |
| `File byte limit exceeded.`                                 | Import a smaller file or configure a larger file limit.                       |
| `Decoded PCM budget exceeded.`                              | Remove unused files, release leases or raise the decoded byte limit.          |
| `Sample Library needs a ready sample.`                      | Wait for the import and use a ready row ID.                                   |
| `Sample lease is released.` / `Sample Library is disposed.` | Keep the lease until use finishes, or create a new library for a new session. |
