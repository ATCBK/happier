/**
 * The Home-governance domain contract.
 *
 * Consumers import this subpath rather than the protocol root so a Home
 * Administration client depends only on governance schemas, exactly as the
 * `changes` and `rpc` domains already do.
 */
export * from './roles.js';
export type { HomeGovernanceActionIdV1 } from './actionsV1.js';
export { HomeEmptinessGetInputV1Schema } from './actionsV1.js';
export * from './capabilities.js';
export * from './policy.js';
export * from './accounts.js';
export * from './projection.js';
export * from './errors.js';
export * from './settings.js';
export * from './audit.js';
export * from './retention.js';
export * from './claim.js';
export * from './reachability.js';
export * from './publicProfiles.js';
