/**
 * Entry point for scanning: paths in, a report out.
 *
 * The filesystem-side counterpart to `hook/`. That area answers a tool call before it lands; this
 * one answers for files already on disk, which is what a git hook or CI can reach and the write-time
 * hook cannot.
 */
export type { ScannedFile, ScanOptions, ScanReport } from './scan.ts'
export type { Exclusion, ExclusionReason, Partitioned, PartitionOptions } from './exclude.ts'
export { DEFAULT_EXCLUSIONS, partitionPaths } from './exclude.ts'
export { fingerprint, scan, ScanError } from './scan.ts'
export type { ScanOutcome } from './report.ts'
export { render, ScanExit } from './report.ts'
