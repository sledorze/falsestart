---
'@sledorze/falsestart': patch
---

Parse on worker threads, so a scan of many files actually uses more than one core.

`parseSource` used the synchronous `parse`, which pins every parse to the main thread. That made
`scan`'s own concurrency setting a fiction: eight fibers, all queued to parse in series. It now uses
`parseAsync`, which the binding runs on a worker thread.

Measured over 60 files: 244 ms serialised against 113 ms with the parses in flight. End to end over
424 files, 2,838 ms to 1,976 ms.

There is no cost for the single-file case the hook always has — 60 sequential parses measured 250 ms
asynchronous against 244 ms synchronous, so the dispatch is lost in the noise.
