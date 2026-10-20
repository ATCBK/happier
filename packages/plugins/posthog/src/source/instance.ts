/**
 * The sole encoder, decoder, validator and byte-measurer of the source-private
 * configured-instance token.
 *
 * The target persists this token opaquely and never parses it, so this module is the
 * only place that knows what its bytes mean. It deliberately carries no account ref or
 * routing origin: the exact Connected Account binding is a separate member of the host
 * matching tuple, and the materialized connection is the only origin authority. A token
 * that could select an origin would become a second deployment authority that a
 * reconfiguration could silently disagree with. Retained unit metadata is presentation
 * only; its optional collision join key never selects a route.
 *
 * Byte measurement lives here for the same reason. `connect/configuration.ts` asks this
 * codec what a prospective environment set would cost before it changes a selection, so
 * capacity is discovered while the user is still choosing rather than when the public
 * administration Action rejects a save.
 */

import { MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1, TriageSourceScopeSelectionV1Schema, TriageSourceScopeUnitV1Schema, type TriageSourceScopeSelectionV1, type TriageSourceScopeUnitV1 } from '@happier-dev/triage-protocol/v1';
import {
    createProtocolStoredReadSchema, defineProtocolArray, defineProtocolLiteral, defineProtocolNumber,
    defineProtocolObject, defineProtocolString, defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';

import { utf8ByteLength } from './map/bounds.js';
import type { PosthogResolvedWindow } from './scan/request.js';

const UUID_PATTERN
    = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * A user-approved window. `exact` freezes both ends; `relative` freezes only the
 * duration and is resolved against the clock once per requested pass, so a stored
 * configuration never silently ages into a different exact range.
 */
export type PosthogWindowPolicy =
    | Readonly<{ kind: 'exact'; from: string; to: string }>
    | Readonly<{ kind: 'relative'; durationMs: number }>;

export type PosthogConfiguredEnvironment = Readonly<{
    /** Team/environment id used in `/api/projects/{project_id}/` routes. */
    teamPathId: number;
    /** Team/environment UUID; the identity component of collision scope. */
    teamUuid: string;
    /** Provider parent project id when exposed. Never a route and never identity. */
    parentProjectId?: number;
    /** Presentation only. */
    displayName: string;
}>;

export type PosthogConfigurationToken = Readonly<{
    v: 1;
    organizationUuid: string;
    /** Omission is accepted only for historical environment-set callers. */
    include?: TriageSourceScopeSelectionV1;
    scopeUnits?: readonly TriageSourceScopeUnitV1[];
    /** Known source-owned routing metadata, not selection authority. */
    environments: readonly PosthogConfiguredEnvironment[];
    scanWindowPolicy: PosthogWindowPolicy;
    detailWindowPolicy: PosthogWindowPolicy;
}>;

export type PosthogConfigurationRejection =
    | 'invalidOrganizationUuid'
    | 'noEnvironments'
    | 'invalidEnvironment'
    | 'duplicateEnvironment'
    | 'invalidWindowPolicy'
    | 'tokenTooLarge';

const PosthogWindowPolicySchema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('exact'), from: defineProtocolString(), to: defineProtocolString() }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('relative'), durationMs: defineProtocolNumber() }, { policy: 'closed' }),
]);
const PosthogConfigurationTokenV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1), organizationUuid: defineProtocolString(),
    include: TriageSourceScopeSelectionV1Schema.optional(),
    scopeUnits: defineProtocolArray(TriageSourceScopeUnitV1Schema).optional(),
    environments: defineProtocolArray(defineProtocolObject({
        teamPathId: defineProtocolNumber(), teamUuid: defineProtocolString(),
        parentProjectId: defineProtocolNumber().optional(), displayName: defineProtocolString(),
    }, { policy: 'closed' })),
    scanWindowPolicy: PosthogWindowPolicySchema, detailWindowPolicy: PosthogWindowPolicySchema,
}, { policy: 'closed' });
const storedConfiguration = createProtocolStoredReadSchema(PosthogConfigurationTokenV1Schema);

export type PosthogConfigurationEncoding =
    | Readonly<{ ok: true; token: string; utf8Bytes: number }>
    | Readonly<{ ok: false; reason: 'tokenTooLarge'; utf8Bytes: number }>
    | Readonly<{
        ok: false;
        reason: Exclude<PosthogConfigurationRejection, 'tokenTooLarge'>;
      }>;

/**
 * The draft window a discovery candidate proposes. It is a starting point for the
 * Settings form, never a durable configuration: only an explicit user-submitted
 * administration Action turns a draft into a configured instance.
 */
export const POSTHOG_DRAFT_WINDOW_POLICY: PosthogWindowPolicy = Object.freeze({
    kind: 'relative',
    durationMs: 30 * 24 * 60 * 60 * 1_000,
});

function isUuid(value: unknown): value is string {
    return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isValidWindowPolicy(value: unknown): value is PosthogWindowPolicy {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const raw = value as Readonly<Record<string, unknown>>;
    if (raw['kind'] === 'exact') {
        return typeof raw['from'] === 'string'
            && typeof raw['to'] === 'string'
            && !Number.isNaN(Date.parse(raw['from']))
            && !Number.isNaN(Date.parse(raw['to']))
            && Object.keys(raw).length === 3;
    }
    if (raw['kind'] === 'relative') {
        const duration = raw['durationMs'];
        return typeof duration === 'number'
            && Number.isSafeInteger(duration)
            && duration > 0
            && Object.keys(raw).length === 2;
    }
    return false;
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
    const actual = Object.keys(value);
    return actual.length === keys.length
        && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function readEnvironment(value: unknown): PosthogConfiguredEnvironment | null {
    if (typeof value !== 'object' || value === null) {
        return null;
    }
    const raw = value as Readonly<Record<string, unknown>>;
    const teamPathId = raw['teamPathId'];
    const teamUuid = raw['teamUuid'];
    const displayName = raw['displayName'];
    const parentProjectId = raw['parentProjectId'];
    const expectedKeys = parentProjectId === undefined
        ? ['teamPathId', 'teamUuid', 'displayName']
        : ['teamPathId', 'teamUuid', 'parentProjectId', 'displayName'];
    if (
        !hasExactKeys(raw, expectedKeys)
        || typeof teamPathId !== 'number'
        || !Number.isSafeInteger(teamPathId)
        || teamPathId <= 0
        || !isUuid(teamUuid)
        || typeof displayName !== 'string'
        || displayName.length === 0
    ) {
        return null;
    }
    if (parentProjectId !== undefined
        && (typeof parentProjectId !== 'number'
            || !Number.isSafeInteger(parentProjectId)
            || parentProjectId <= 0)) {
        return null;
    }
    return {
        teamPathId,
        teamUuid,
        ...(parentProjectId === undefined ? {} : { parentProjectId }),
        displayName,
    };
}

function validate(
    configuration: PosthogConfigurationToken,
): Exclude<PosthogConfigurationRejection, 'tokenTooLarge'> | null {
    if (!isUuid(configuration.organizationUuid)) {
        return 'invalidOrganizationUuid';
    }
    const selection = readPosthogEnvironmentSelection(configuration);
    if (selection === null) {
        return 'noEnvironments';
    }
    if (configuration.scopeUnits?.some((unit) => !TriageSourceScopeUnitV1Schema.safeParse(unit).success)) return 'invalidEnvironment';
    const seen = new Set<string>();
    for (const environment of configuration.environments) {
        if (readEnvironment(environment) === null) {
            return 'invalidEnvironment';
        }
        if (seen.has(environment.teamUuid)) {
            return 'duplicateEnvironment';
        }
        seen.add(environment.teamUuid);
    }
    if (!isValidWindowPolicy(configuration.scanWindowPolicy)
        || !isValidWindowPolicy(configuration.detailWindowPolicy)) {
        return 'invalidWindowPolicy';
    }
    return null;
}

export function readPosthogEnvironmentSelection(configuration: PosthogConfigurationToken): TriageSourceScopeSelectionV1 | null {
    const parsed = TriageSourceScopeSelectionV1Schema.safeParse(configuration.include ?? {
        kind: 'selected', unitIds: configuration.environments.map((environment) => environment.teamUuid),
    });
    if (!parsed.success || (parsed.data.kind === 'selected' && !parsed.data.unitIds.every(isUuid))) return null;
    return parsed.data;
}

/** Candidate disclosure needs membership only; authoritative reads resolve live routing. */
export function isPosthogEnvironmentIncluded(configuration: PosthogConfigurationToken, teamUuid: string): boolean {
    const selection = readPosthogEnvironmentSelection(configuration);
    return isUuid(teamUuid) && (selection?.kind === 'all' || (selection?.kind === 'selected' && selection.unitIds.includes(teamUuid)));
}

/**
 * Encodes one prospective configuration and reports its exact UTF-8 cost.
 *
 * The measurement is UTF-8 rather than a character count or an environment count
 * because the published limit is a byte limit: a multi-byte display name costs more
 * than its length suggests, and an approximation would either reject valid selections
 * or discover the ceiling only after the Action was already invoked.
 */
export function encodePosthogConfiguration(
    configuration: PosthogConfigurationToken,
): PosthogConfigurationEncoding {
    if (configuration.v !== 1) {
        return { ok: false, reason: 'invalidWindowPolicy' };
    }
    const rejection = validate(configuration);
    if (rejection !== null) {
        return { ok: false, reason: rejection };
    }
    const token = JSON.stringify({
        v: 1,
        organizationUuid: configuration.organizationUuid,
        include: readPosthogEnvironmentSelection(configuration),
        ...(configuration.scopeUnits === undefined ? {} : { scopeUnits: configuration.scopeUnits }),
        environments: configuration.environments.map((environment) => ({
            teamPathId: environment.teamPathId,
            teamUuid: environment.teamUuid,
            ...(environment.parentProjectId === undefined
                ? {}
                : { parentProjectId: environment.parentProjectId }),
            displayName: environment.displayName,
        })),
        scanWindowPolicy: configuration.scanWindowPolicy,
        detailWindowPolicy: configuration.detailWindowPolicy,
    });
    const utf8Bytes = utf8ByteLength(token);
    if (utf8Bytes > MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1) {
        return { ok: false, reason: 'tokenTooLarge', utf8Bytes };
    }
    return { ok: true, token, utf8Bytes };
}

/**
 * Decodes a token the target handed back. Every rejection returns `null`: a token this
 * codec did not mint, or one that no longer parses, cannot select an environment, and
 * guessing a partial meaning would route a read at an unintended provider scope.
 */
export function decodePosthogConfiguration(
    configuration: Readonly<{ v: 1; token: string }>,
): PosthogConfigurationToken | null {
    if (configuration.v !== 1) {
        return null;
    }
    if (utf8ByteLength(configuration.token) > MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1) {
        return null;
    }
    let decoded: unknown;
    try {
        decoded = JSON.parse(configuration.token);
    } catch {
        return null;
    }
    const result = storedConfiguration.safeParse(decoded);
    if (!result.success) return null;
    const raw = result.data;
    if (!isUuid(raw.organizationUuid)) return null;
    const rawEnvironments = raw['environments'];
    if (!Array.isArray(rawEnvironments)) {
        return null;
    }
    const environments: PosthogConfiguredEnvironment[] = [];
    const seen = new Set<string>();
    for (const rawEnvironment of rawEnvironments) {
        const environment = readEnvironment(rawEnvironment);
        if (environment === null || seen.has(environment.teamUuid)) {
            return null;
        }
        seen.add(environment.teamUuid);
        environments.push(environment);
    }
    const scanWindowPolicy = raw['scanWindowPolicy'];
    const detailWindowPolicy = raw['detailWindowPolicy'];
    if (!isValidWindowPolicy(scanWindowPolicy) || !isValidWindowPolicy(detailWindowPolicy)) {
        return null;
    }
    const normalized = {
        v: 1,
        organizationUuid: raw['organizationUuid'],
        ...(raw.include === undefined ? {} : { include: raw.include }),
        ...(raw.scopeUnits === undefined ? {} : { scopeUnits: raw.scopeUnits }),
        environments,
        scanWindowPolicy,
        detailWindowPolicy,
    } satisfies PosthogConfigurationToken;
    const include = readPosthogEnvironmentSelection(normalized);
    return include === null ? null : { ...normalized, include };
}

/**
 * Freezes a policy into the one exact provider window a pass will send.
 *
 * A relative policy is resolved once per requested pass and then reused for every page
 * of that pass. Re-resolving per page would move the window under an offset walk and
 * make the accepted pages describe different result sets.
 */
export function resolvePosthogWindowPolicy(
    policy: PosthogWindowPolicy,
    nowMs: number,
): PosthogResolvedWindow {
    if (policy.kind === 'exact') {
        return { from: policy.from, to: policy.to };
    }
    return {
        from: new Date(nowMs - policy.durationMs).toISOString(),
        to: new Date(nowMs).toISOString(),
    };
}
