export type CuaPowerIntent = 'start' | 'stop' | 'suspend' | 'resume';
export type CuaPowerRoute = 'local' | 'cloud';

/** The single refusal code for an intent a route does not offer, on every Cua route. */
export const CUA_UNSUPPORTED_INTENT = 'cua_unsupported_intent';

/**
 * Cua has one park verb and one wake verb: `sandbox suspend` and `sandbox resume`. Every route
 * speaks them; Happier's Stop and Suspend both park, Start and Resume both wake. What differs is
 * only what the route can truthfully report afterwards (below), never the verb.
 */
export function cuaNativePowerVerb(intent: CuaPowerIntent): 'suspend' | 'resume' {
    return intent === 'stop' || intent === 'suspend' ? 'suspend' : 'resume';
}

/**
 * Parked is memory-preserving "suspended" on a local sandbox. A BYOC VM keeps its disk but
 * not its memory, so the same verb is observed, and offered, as "stopped" there.
 */
export function cuaPowerAfter(intent: CuaPowerIntent, route: CuaPowerRoute): 'running' | 'suspended' | 'stopped' {
    if (cuaNativePowerVerb(intent) === 'resume') return 'running';
    return route === 'local' ? 'suspended' : 'stopped';
}
