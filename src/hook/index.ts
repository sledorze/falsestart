/**
 * Entry point for the agent-protocol adapter: a tool call in, a verdict and a response out.
 *
 * This is the only area that knows what a PreToolUse payload looks like, for either agent and in
 * either of that agent's envelope spellings, or what that agent's exit codes mean. The domain
 * beneath it has no idea an agent exists.
 */
export type { AgentContract, AgentId, Decision, DecideOptions, Envelope } from './decide.ts'
export type { Diagnosis, DiagnoseOptions } from './doctor.ts'
export { diagnose } from './doctor.ts'
export { AGENT_CONTRACTS, AGENTS, decide, judgesPayload, WRITE_TOOLS } from './decide.ts'
export type { FailurePolicy, HookResponse, RespondOptions } from './respond.ts'
export { FAILURE_POLICIES, respond } from './respond.ts'
