/**
 * Entry point for the agent-protocol adapter: a tool call in, a verdict and a response out.
 *
 * This is the only area that knows what a PreToolUse payload looks like or what its exit codes
 * mean. The domain beneath it has no idea an agent exists.
 */
export type { Decision } from './decide.ts'
export { decide, judgesPayload } from './decide.ts'
export type { HookResponse, RespondOptions } from './respond.ts'
export { respond } from './respond.ts'
