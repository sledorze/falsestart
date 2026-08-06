/**
 * Entry point for the agent-protocol adapter: a tool call in, a verdict and a response out.
 *
 * This is the only area that knows what a PreToolUse payload looks like or what its exit codes
 * mean. The domain beneath it has no idea an agent exists.
 */
export type { Decision, DecideOptions } from './decide.ts'
export type { Diagnosis, DiagnoseOptions } from './doctor.ts'
export { diagnose } from './doctor.ts'
export { decide, judgesPayload, WRITE_TOOLS } from './decide.ts'
export type { FailurePolicy, HookResponse, RespondOptions } from './respond.ts'
export { FAILURE_POLICIES, respond } from './respond.ts'
