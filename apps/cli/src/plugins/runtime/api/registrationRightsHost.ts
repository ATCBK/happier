import {
    createPluginRegistrationScope,
    type PluginAgentRuntimeRegistration,
    type PluginRegistrationRight,
    type PluginRuntimeRegistration,
} from '@happier-dev/plugin-sdk/host/registration';
import type { PluginApi, PluginAccountApi } from '@happier-dev/plugin-sdk';
import type {
    AgentSessionRunnerFactoryLocatorV1,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { derivePluginDaemonContributionRegistrationRights } from '@happier-dev/protocol/plugins/contributions/catalog';

import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';

export type ContributionRegistrationRight = PluginRegistrationRight;
export type AgentContributionRuntimeRegistration = PluginAgentRuntimeRegistration;
export type ContributionRuntimeRegistration = PluginRuntimeRegistration;
type AgentExternalSessionsContribution = NonNullable<
    PluginAgentRuntimeRegistration['externalSessions']
>;

/**
 * Captures an immutable host-facing External Sessions façade for a runner leaf
 * that was already authenticated at activation. This deliberately snapshots
 * only once for the retained-runtime consumer; it must never be used to
 * compare a second snapshot with an activation registration.
 */
export function snapshotAgentExternalSessionsThroughRegistrationScope(
    params: Readonly<{
        pluginId: string;
        localAgentId: string;
        contribution: unknown;
    }>,
): AgentExternalSessionsContribution {
    const scope = createPluginRegistrationScope({
        pluginId: params.pluginId,
        target: { realm: 'daemon' },
        rights: [Object.freeze({
            family: 'agents',
            localId: params.localAgentId,
            target: Object.freeze({ realm: 'daemon' as const }),
            requiredFields: Object.freeze(['externalSessions'] as const),
        })],
    });
    // The registration scope is the runtime validation boundary for a leaf
    // export whose type cannot be trusted before it is captured.
    scope.api.agents.registerExternalSessions(
        params.localAgentId,
        params.contribution as AgentExternalSessionsContribution,
    );
    let registrations: readonly ContributionRuntimeRegistration[];
    try {
        registrations = scope.commit();
    } catch (error) {
        throw new Error(
            'Agent External Sessions contribution is invalid',
            { cause: error },
        );
    }
    const [registration] = registrations;
    if (
        registration?.family !== 'agents'
        || registration.value.externalSessions === undefined
    ) {
        throw new Error(
            `Agent '${params.localAgentId}' External Sessions contribution was not captured`,
        );
    }
    return registration.value.externalSessions;
}

export type ValidatedAgentSessionRunnerFactoryRegistrationV1 = Readonly<{
    locator: AgentSessionRunnerFactoryLocatorV1;
    normalizedModulePath: string;
    loadMode: 'immutable-js' | 'source-ts';
}>;

const validatedSessionRunnerFactories = new WeakMap<
    PluginAgentRuntimeRegistration,
    ValidatedAgentSessionRunnerFactoryRegistrationV1
>();

export function deriveContributionRegistrationRightsForManifest(
    manifest: CanonicalPluginManifest,
): readonly ContributionRegistrationRight[] {
    return derivePluginDaemonContributionRegistrationRights(
        manifest.contributes as unknown as Readonly<Record<string, unknown>>,
    );
}

export function recordValidatedAgentSessionRunnerFactory(
    registration: PluginAgentRuntimeRegistration,
    validated: ValidatedAgentSessionRunnerFactoryRegistrationV1,
): void {
    if (!registration.factory || !registration.sessionRunnerFactory) {
        throw new TypeError('Only a locator-bearing Agent runtime registration can be validated');
    }
    if (validated.locator !== registration.sessionRunnerFactory) {
        throw new TypeError('Validated Agent session runner locator must be the registration snapshot');
    }
    if (validatedSessionRunnerFactories.has(registration)) {
        throw new TypeError('Agent session runner factory registration was validated more than once');
    }
    validatedSessionRunnerFactories.set(registration, Object.freeze({ ...validated }));
}

export function readValidatedAgentSessionRunnerFactory(
    registration: PluginAgentRuntimeRegistration,
): ValidatedAgentSessionRunnerFactoryRegistrationV1 | null {
    return validatedSessionRunnerFactories.get(registration) ?? null;
}

/**
 * Production lifecycle wrapper around the shared daemon-independent SDK
 * registration contract. Occurrence currentness and compatibility diagnostics
 * remain CLI host policy and are not exposed by the SDK testkit.
 */
type ContributionRegistrationHostParams = Readonly<{
    pluginId: string;
    occurrenceId: string;
    rights: readonly ContributionRegistrationRight[];
    isOccurrenceCurrent(): boolean;
    /**
     * Host-owned bound for one independent registration-cleanup attempt;
     * forwarded to the SDK registration scope, which bounds each captured
     * cleanup individually while preserving its reverse-order dependency.
     */
    cleanupTimeoutMs?: number;
    onAgentExternalSessionsRegistration?: (
        localAgentId: string,
        contribution: AgentExternalSessionsContribution,
    ) => void;
}>;
type AccountRegistrationTarget = Readonly<{ realm: 'account'; artifactId: string; exportName: string }>;
type ContributionRegistrationHost<TApi> = Readonly<{
    api: TApi;
    commit(): readonly ContributionRuntimeRegistration[];
    registrations(): readonly ContributionRuntimeRegistration[];
    diagnostics(): readonly PluginCompatibilityDiagnostic[];
    dispose(): Promise<void>;
}>;
export function createContributionRegistrationHost(params: ContributionRegistrationHostParams & Readonly<{ target: AccountRegistrationTarget }>): ContributionRegistrationHost<PluginAccountApi>;
export function createContributionRegistrationHost(params: ContributionRegistrationHostParams & Readonly<{ target?: Readonly<{ realm: 'daemon' }> }>): ContributionRegistrationHost<PluginApi>;
export function createContributionRegistrationHost(params: ContributionRegistrationHostParams & Readonly<{ target?: Readonly<{ realm: 'daemon' }> | AccountRegistrationTarget }>): ContributionRegistrationHost<PluginApi | PluginAccountApi> {
    const diagnostics: PluginCompatibilityDiagnostic[] = [];
    const scopeParams = {
        pluginId: params.pluginId,
        rights: params.rights,
        ...(params.cleanupTimeoutMs === undefined
            ? {}
            : { cleanupTimeoutMs: params.cleanupTimeoutMs }),
        assertAvailable() {
            if (!params.isOccurrenceCurrent()) {
                throw new Error(`Plugin '${params.pluginId}' cannot register against retired occurrence '${params.occurrenceId}'`);
            }
        },
        onFailure(message: string) {
            if (diagnostics.length === 0) {
                diagnostics.push(Object.freeze({
                    code: 'plugin_activation_failed',
                    message,
                }));
            }
        },
    };
    const scope = params.target?.realm === 'account'
        ? createPluginRegistrationScope({ ...scopeParams, target: params.target })
        : createPluginRegistrationScope({ ...scopeParams, target: { realm: 'daemon' } });
    let disposalPromise: Promise<void> | null = null;

    const api =
        params.onAgentExternalSessionsRegistration === undefined || !('agents' in scope.api)
            ? scope.api
            : Object.freeze({
                ...scope.api,
                agents: Object.freeze({
                    ...scope.api.agents,
                    registerExternalSessions(
                        localAgentId: string,
                        contribution: AgentExternalSessionsContribution,
                    ): void {
                            if (!('agents' in scope.api)) throw new Error('Agent registration requires the daemon realm');
                            scope.api.agents.registerExternalSessions(
                            localAgentId,
                            contribution,
                        );
                        params.onAgentExternalSessionsRegistration!(
                            localAgentId,
                            contribution,
                        );
                    },
                }),
            });

    return Object.freeze({
        api,
        commit: scope.commit,
        registrations: scope.registrations,
        diagnostics() {
            return Object.freeze([...diagnostics]);
        },
        dispose() {
            if (disposalPromise) return disposalPromise;
            disposalPromise = scope.dispose();
            return disposalPromise;
        },
    });
}
