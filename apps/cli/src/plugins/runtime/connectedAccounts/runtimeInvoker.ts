import { randomUUID } from 'node:crypto';
import { createSensitiveDiagnosticTextRedactor } from '@happier-dev/protocol/bugs/reports/redaction';
import { logger } from '@/ui/logger';
import { observeCurrentConnectedServiceMaterializationPhase as observeMaterializationPhase } from '@/daemon/connectedServices/materialize/materializationPhase';
import { ConnectedServiceQuotaRecoveryCreditsV1Schema, ConnectedServiceQuotaRecoveryCreditDetailsByIdV1Schema } from '@happier-dev/protocol/connect/connected-service-schemas';
import type { ConnectedServiceQuotaRecoveryCreditsV1, ConnectedServiceQuotaRecoveryCreditDetailsByIdV1 } from '@happier-dev/protocol/connect/connected-service-schemas';

import { sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type { PluginHostAccessRequestV2 } from '@happier-dev/protocol';
import {
    type ConnectedAccountMaterializationRequest,
    type ConnectedAccountAuthenticationContext as PluginConnectedAccountAuthenticationContext,
    type ConnectedAccountRuntime as PluginConnectedAccountRuntime,
    type ConnectedAccountRuntimeConfiguration as PluginConnectedAccountRuntimeConfiguration } from '@happier-dev/plugin-sdk/connected-accounts';
import {
    type PluginContributionRef,
} from '@happier-dev/plugin-sdk';

import type { PluginNetworkAddressResolver } from '@/plugins/runtime/fetch/originLocality';
import { createPluginInvocationPresentation } from '@/plugins/runtime/invocation/services/interactions';
import type {
    PluginInvocationServicesSeed,
    PluginInvocationServiceBinding,
} from '@/plugins/runtime/invocation/services/types';
import {
    createPluginInvocationLifetime,
    type PluginInvocationLifetime,
} from '@/plugins/runtime/invocation/lifetime';
import type {
    PluginInvocationHostPolicy,
    ResolvePluginInvocationHostPolicy,
} from '@/plugins/runtime/hostAccess/resolve';

import type {
    ConnectedAccountAttemptProviderInvocation,
} from './authenticationAttemptOwner';
import {
    bindConnectedAccountConfiguredOrigins,
    matchesConnectedAccountOriginTarget,
    resolveConnectedAccountConfiguredOrigins,
    type ConnectedAccountConfiguredEndpoint,
} from './configuredOrigins';
import {
    ConnectedAccountRuntimeInvocationNotStartedError,
    type ConnectedAccountRuntimeLease,
    type ConnectedAccountHostRuntimeLease,
    type ConnectedAccountPluginRuntimeLease,
} from './contributionRegistry';
import {
    snapshotConnectedAccountAuthenticationResult,
    snapshotConnectedAccountEstablishedResult,
    staleConnectedAccountProducerResult,
} from './producerResultSnapshot';
import type {
    HostConnectedAccountAuthenticationContext, HostConnectedAccountReadContext,
    ConnectedAccountAuthenticationModeRuntimeFor, ConnectedAccountEstablishedRuntimeFor,
} from './hostRuntime';

type MaybePromise<T> = T | Promise<T>;
type PluginConnectedAccountCredentialStore =
    PluginConnectedAccountAuthenticationContext['attemptCredentials'];
type PluginConnectedAccountReadContext =
    Parameters<PluginConnectedAccountRuntime['status']>[0];
type ConnectedAccountCredentialReader =
    PluginConnectedAccountReadContext['credentials'];
type ConnectedAccountCallbackCurrentnessPhase = 'beforeCallback' | 'afterCallback';
type InvocationContext<Context, Lease> = Readonly<{
    lease: Lease;
    context: Context;
    registerRawForRedaction(value: string): void;
    redactDiagnosticText?(value: string): string;
    assertCurrent(phase?: ConnectedAccountCallbackCurrentnessPhase): Promise<void>;
    lifetime: PluginInvocationLifetime;
}>;
type AuthenticationInvocationContext =
    | (InvocationContext<HostConnectedAccountAuthenticationContext, ConnectedAccountHostRuntimeLease> & { owner: 'host' })
    | (InvocationContext<PluginConnectedAccountAuthenticationContext, ConnectedAccountPluginRuntimeLease> & { owner: 'plugin' });
type EstablishedInvocationContext =
    | (InvocationContext<HostConnectedAccountReadContext, ConnectedAccountHostRuntimeLease> & {
        owner: 'host';
        assertFieldReadCurrent(): Promise<void>;
    })
    | (InvocationContext<PluginConnectedAccountReadContext, ConnectedAccountPluginRuntimeLease> & {
        owner: 'plugin';
        assertFieldReadCurrent(): Promise<void>;
    });

/**
 * The typed invocation boundary, rather than a recursive runtime wrapper,
 * owns the occurrence/currentness fence around every plugin callback. The
 * callback's own rejection stays visible while current; a retirement while it
 * is pending wins over that stale producer result just as every other host
 * currentness boundary does.
 */
async function invokeCurrentConnectedAccountCallback<TResult, TOutput>(
    assertCurrent: (phase: ConnectedAccountCallbackCurrentnessPhase) => Promise<void>,
    callback: () => MaybePromise<TResult>,
    snapshotResult: (result: TResult) => TOutput,
): Promise<TOutput>;
async function invokeCurrentConnectedAccountCallback<TResult>(
    assertCurrent: (phase: ConnectedAccountCallbackCurrentnessPhase) => Promise<void>,
    callback: () => MaybePromise<TResult>,
): Promise<TResult>;
async function invokeCurrentConnectedAccountCallback(
    assertCurrent: (phase: ConnectedAccountCallbackCurrentnessPhase) => Promise<void>,
    callback: () => MaybePromise<unknown>,
    snapshotResult?: (result: unknown) => unknown,
): Promise<unknown> {
    await observeMaterializationPhase('runtime_callback_before', () => assertCurrent('beforeCallback'));
    try {
        const result = await observeMaterializationPhase('runtime_callback', callback);
        return snapshotResult ? snapshotResult(result) : result;
    } finally {
        await observeMaterializationPhase('runtime_callback_after', () => assertCurrent('afterCallback'));
    }
}

export type ConnectedAccountRuntimeAuthenticationInvocation =
    ConnectedAccountAttemptProviderInvocation & Readonly<{
        isConfigurationCurrent(
            configuration: PluginConnectedAccountRuntimeConfiguration,
        ): MaybePromise<boolean>;
        configurationRevocationSignal?(
            configuration: PluginConnectedAccountRuntimeConfiguration,
        ): AbortSignal | undefined;
    }>;

export type ConnectedAccountRuntimeEstablishedTarget = Readonly<{
    account: Readonly<{
        service: PluginContributionRef;
        accountId: string;
    }>;
    expectedCredentialRevision: string;
    expectedRuntimeConfigurationRevision: string;
}>;

export type ConnectedAccountRuntimeEstablishedOperation =
    | Readonly<{
        kind: 'refresh';
        operationId: string;
        stagedCredentials: PluginConnectedAccountCredentialStore;
    }>
    | Readonly<{
        kind: 'enrichCredentialContext';
        operationId: string;
        stagedCredentials: PluginConnectedAccountCredentialStore;
    }>
    | Readonly<{ kind: 'status' }>
    | Readonly<{ kind: 'quota' }>
    | Readonly<{ kind: 'recoveryCredits.read' }>
    | Readonly<{
        kind: 'recoveryCredits.consume';
        request: Readonly<{ idempotencyKey: string; providerCreditId?: string; providerLimitIds?: readonly string[] }>;
    }>
    | Readonly<{ kind: 'revoke' }>
    | Readonly<{
        kind: 'materialize';
        request: ConnectedAccountMaterializationRequest;
        existingFiles?: Readonly<Record<string, Uint8Array>>;
    }>;

export type ConnectedAccountRuntimeEstablishedInvocation<
    TOperation extends ConnectedAccountRuntimeEstablishedOperation =
        ConnectedAccountRuntimeEstablishedOperation,
> = Readonly<{
    target: ConnectedAccountRuntimeEstablishedTarget;
    operation: TOperation;
    context: Readonly<{
        account: ConnectedAccountRuntimeEstablishedTarget['account'];
        configuration: PluginConnectedAccountRuntimeConfiguration;
        credentials: ConnectedAccountCredentialReader;
    }>;
    isConfigurationCurrent(
        configuration: PluginConnectedAccountRuntimeConfiguration,
    ): MaybePromise<boolean>;
    configurationRevocationSignal?(
        configuration: PluginConnectedAccountRuntimeConfiguration,
    ): AbortSignal | undefined;
    isCredentialRevisionCurrent(): MaybePromise<boolean>;
    signal?: AbortSignal;
}>;

async function assertEstablishedAuthorityCurrent(
    input: ConnectedAccountRuntimeEstablishedInvocation,
    lease: ConnectedAccountRuntimeLease,
    signal: AbortSignal,
): Promise<void> {
    signal.throwIfAborted();
    if (!lease.isCurrent()) throw staleConnectedAccountProducerResult(input.operation.kind);
    // Both observations are independent read-only authorities. Preserve each
    // fence without adding their network latency to the same credential read.
    const [configurationCurrent, credentialCurrent] = await Promise.all([
        observeMaterializationPhase('runtime_configuration_currentness', () => input.isConfigurationCurrent(input.context.configuration)),
        observeMaterializationPhase('runtime_credential_currentness', () => input.isCredentialRevisionCurrent()),
    ]);
    signal.throwIfAborted();
    if (!lease.isCurrent() || !configurationCurrent || !credentialCurrent) {
        throw staleConnectedAccountProducerResult(input.operation.kind);
    }
}

async function assertEstablishedFieldReadCurrent(
    input: ConnectedAccountRuntimeEstablishedInvocation,
    lease: ConnectedAccountRuntimeLease,
    signal: AbortSignal,
    assertCurrent: () => Promise<void>,
): Promise<void> {
    if (
        input.operation.kind !== 'materialize'
        && input.operation.kind !== 'refresh'
        && input.operation.kind !== 'enrichCredentialContext'
        && input.operation.kind !== 'status'
    ) {
        return await assertCurrent();
    }
    // Materialization, status and refresh consume the invocation's immutable
    // credential snapshot; refresh writes only to a staged local store. Callback
    // admission and settlement own remote revision checks, while each field still
    // obeys cancellation, occurrence retirement and observed config revocation.
    signal.throwIfAborted();
    if (!lease.isCurrent() || input.configurationRevocationSignal?.(input.context.configuration)?.aborted) {
        throw staleConnectedAccountProducerResult(input.operation.kind);
    }
}

export type ConnectedAccountRuntimeEstablishedResult<
    TOperation extends ConnectedAccountRuntimeEstablishedOperation,
> =
    TOperation['kind'] extends 'recoveryCredits.read'
        ? Awaited<ReturnType<NonNullable<PluginConnectedAccountRuntime['recoveryCredits']>['read']>> | null
        : TOperation['kind'] extends 'recoveryCredits.consume'
            ? Awaited<ReturnType<NonNullable<PluginConnectedAccountRuntime['recoveryCredits']>['consume']>> | null
    : TOperation['kind'] extends 'refresh' | 'enrichCredentialContext'
        ? Awaited<ReturnType<PluginConnectedAccountRuntime['refresh']>>
        : TOperation['kind'] extends 'status'
            ? Awaited<ReturnType<PluginConnectedAccountRuntime['status']>>
            : TOperation['kind'] extends 'quota'
                ? (Awaited<ReturnType<NonNullable<PluginConnectedAccountRuntime['quota']>>> & Readonly<{
                    /** Host-composed from the declared recovery facet under this invocation's admitted lease. */
                    recoveryCredits?: ConnectedServiceQuotaRecoveryCreditsV1;
                    recoveryCreditDetails?: ConnectedServiceQuotaRecoveryCreditDetailsByIdV1;
                }>) | null
                : TOperation['kind'] extends 'revoke'
                    ? Awaited<ReturnType<PluginConnectedAccountRuntime['revoke']>>
                    : Awaited<ReturnType<PluginConnectedAccountRuntime['materialize']>>;

export type ConnectedAccountHostRuntimeInvoker = Readonly<{
    invokeAuthentication(
        input: ConnectedAccountRuntimeAuthenticationInvocation,
    ): Promise<unknown>;
    invokeEstablished<
        TOperation extends ConnectedAccountRuntimeEstablishedOperation,
    >(
        input: ConnectedAccountRuntimeEstablishedInvocation<TOperation>,
    ): Promise<ConnectedAccountRuntimeEstablishedResult<TOperation>>;
}>;

function sameService(left: PluginContributionRef, right: PluginContributionRef): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
}

function hasConnectedAccountOriginRequest(
    pluginId: string,
    service: PluginContributionRef,
    entries: readonly Readonly<{
        request: PluginHostAccessRequestV2;
        required: boolean;
    }>[],
): boolean {
    return entries.some(({ request }) => (
        (request.capability === 'network' || request.capability === 'network.client')
        && request.scope.targets.some((target) => (
            target.kind === 'connectedAccountOrigin'
            && matchesConnectedAccountOriginTarget(
                pluginId,
                service,
                target,
            )
        ))
    ));
}

function resolveHostAccessEntries(
    requests: readonly Readonly<{
        request: PluginHostAccessRequestV2;
        required: boolean;
    }>[],
    policy: PluginInvocationHostPolicy,
): readonly Readonly<{
    request: PluginHostAccessRequestV2;
    required: boolean;
    status: PluginInvocationHostPolicy['hostAccess'][number]['status'];
}>[] {
    if (policy.hostAccess.length !== requests.length) {
        throw new Error('Connected-account HostAccess policy result is incomplete');
    }
    return Object.freeze(requests.map((entry, index) => Object.freeze({
        ...entry,
        status: policy.hostAccess[index]!.status,
    })));
}

function authenticationUnavailable(code: string): Readonly<{
    status: 'unavailable';
    diagnostic: Readonly<{ code: string; severity: 'error' }>;
}> {
    return Object.freeze({
        status: 'unavailable',
        diagnostic: Object.freeze({ code, severity: 'error' }),
    });
}

export function createConnectedAccountHostRuntimeInvoker(params: Readonly<{
    resolveRuntime(ref: PluginContributionRef): Promise<ConnectedAccountRuntimeLease | null>;
    resolvePlugin(ref: PluginContributionRef): Readonly<{
        version: string;
        hostAccessRequests: readonly Readonly<{
            request: PluginHostAccessRequestV2;
            required: boolean;
        }>[];
    }> | null;
    resolveHostPolicy: ResolvePluginInvocationHostPolicy;
    createServices(
        seed: PluginInvocationServicesSeed,
        binding: PluginInvocationServiceBinding,
    ): PluginConnectedAccountAuthenticationContext['services'];
    registerRawForRedaction(
        seed: PluginInvocationServicesSeed,
        value: string,
    ): void;
    redactDiagnosticText?(
        seed: PluginInvocationServicesSeed,
        value: string,
    ): string;
    resolveHostOwnedConfiguredEndpoints(
        service: PluginContributionRef,
        configuration: PluginConnectedAccountRuntimeConfiguration,
    ): MaybePromise<readonly ConnectedAccountConfiguredEndpoint[]>;
    /** DNS boundary for the private-network decision; defaults to the host resolver. */
    resolveNetworkAddresses?: PluginNetworkAddressResolver;
}>): ConnectedAccountHostRuntimeInvoker {
    function hostRedaction(lifetime: PluginInvocationLifetime) {
        const redactor = createSensitiveDiagnosticTextRedactor();
        return Object.freeze({
            registerRawForRedaction(value: string) {
                const lease = redactor.register([value]);
                lifetime.retainCleanup({ async dispose() { lease.close(); } });
            },
            redactDiagnosticText: redactor.redact,
        });
    }

    function guardConfiguration(
        source: PluginConnectedAccountRuntimeConfiguration,
        assertCurrent: () => Promise<void>,
        register: (value: string) => void,
    ): PluginConnectedAccountRuntimeConfiguration {
        return Object.freeze({ ...source, async getSecret(fieldId, options) {
            await assertCurrent();
            const value = await source.getSecret(fieldId, options);
            await assertCurrent();
            if (value !== null) register(value);
            return value;
        } });
    }

    async function createContext(input: ConnectedAccountRuntimeAuthenticationInvocation): Promise<AuthenticationInvocationContext> {
        const lease = input.admission.runtimeCustody?.lease
            ?? await params.resolveRuntime(input.admission.service);
        if (!lease) {
            throw new Error('Connected-account runtime is unavailable');
        }
        if (!sameService(lease.ref, input.admission.service)) {
            throw new Error('Connected-account runtime does not match the captured service');
        }
        if (lease.owner === 'host') {
            const lifetime = createPluginInvocationLifetime(input.signal);
            const redaction = hostRedaction(lifetime);
            const assertCurrent = async () => {
                if (lifetime.signal.aborted) throw lifetime.signal.reason ?? new Error('Connected-account authentication was aborted');
                if (!await input.isConfigurationCurrent(input.context.configuration)) {
                    throw new Error('Connected-account authentication configuration is no longer current');
                }
            };
            const context: HostConnectedAccountAuthenticationContext = Object.freeze({
                ...input.context,
                signal: lifetime.signal, invokedAtMs: lifetime.invokedAtMs,
                configuration: guardConfiguration(input.context.configuration, assertCurrent, redaction.registerRawForRedaction),
                attemptCredentials: guardStagedCredentials(input.context.attemptCredentials, assertCurrent, redaction.registerRawForRedaction),
                async stageAccountConfiguration(replacement) {
                    await assertCurrent();
                    const stage = input.context.stageAccountConfiguration;
                    if (!stage) throw new Error('Host account configuration staging is unavailable');
                    for (const value of Object.values(replacement.secretValues ?? {})) redaction.registerRawForRedaction(value);
                    await stage(replacement);
                    await assertCurrent();
                },
            });
            return Object.freeze({ owner: 'host', lease, context, ...redaction, assertCurrent, lifetime });
        }
        const plugin = params.resolvePlugin(lease.ref);
        if (!plugin) {
            throw new Error('Connected-account plugin package identity is unavailable');
        }
        const lifetime = createPluginInvocationLifetime(input.signal);
        const signal = lifetime.signal;
        const qualifiedId = `${lease.ref.pluginId}/connectedAccountDescriptors/${lease.ref.localId}`;
        const seed: PluginInvocationServicesSeed = Object.freeze({
            plugin: Object.freeze({ id: lease.ref.pluginId, version: plugin.version }),
            contribution: Object.freeze({
                id: lease.ref.localId,
                qualifiedId,
            }),
            occurrenceId: lease.occurrenceId,
            sourceCustody: lease.sourceCustody,
            correlationId: randomUUID(),
            surface: 'cli',
            signal,
            redactionLifetimeSignal: lifetime.redactionLifetimeSignal,
            // The daemon retains the registry lease through this invocation.
            // Reload publication does not retire an already-entered auth flow.
            isOccurrenceCurrent: () => !signal.aborted,
        });
        const assertCurrent = async (
            _phase: ConnectedAccountCallbackCurrentnessPhase = 'afterCallback',
        ): Promise<void> => {
            if (signal.aborted) {
                throw signal.reason instanceof Error
                    ? signal.reason
                    : new Error('Connected-account authentication operation was aborted');
            }
            if (!await input.isConfigurationCurrent(input.context.configuration)) {
                throw new Error('Connected-account authentication runtime is no longer current');
            }
        };
        try {
            const policy = params.resolveHostPolicy({
                pluginId: lease.ref.pluginId,
                occurrenceId: lease.occurrenceId,
                qualifiedId,
            }, {
                hostAccessRequests: plugin.hostAccessRequests,
                surface: 'cli',
                signal,
            });
            const hasQualifiedProducerNetworkAuthority = hasConnectedAccountOriginRequest(
                lease.ref.pluginId,
                lease.ref,
                plugin.hostAccessRequests,
            );
            // Literal origins already belong to the canonical HostAccess binding.
            // Only configured origins need additional account-scoped resolution.
            let serviceBinding = policy.serviceBinding;
            if (hasQualifiedProducerNetworkAuthority) {
                const configurationRevocationSignal = input.configurationRevocationSignal?.(
                    input.context.configuration,
                );
                const resolution = await resolveConnectedAccountConfiguredOrigins({
                    pluginId: lease.ref.pluginId,
                    service: lease.ref,
                    occurrenceId: lease.occurrenceId,
                    configuration: input.context.configuration,
                    hostAccessRequests: resolveHostAccessEntries(
                        plugin.hostAccessRequests,
                        policy,
                    ),
                    resolveHostOwnedConfiguredEndpoints: async (configuration) => (
                        await params.resolveHostOwnedConfiguredEndpoints(lease.ref, configuration)
                    ),
                    isConfigurationCurrent: input.isConfigurationCurrent,
                    ...(configurationRevocationSignal === undefined
                        ? {}
                        : { configurationRevocationSignal }),
                    isOccurrenceCurrent: () => !signal.aborted,
                    ...(params.resolveNetworkAddresses
                        ? { resolveNetworkAddresses: params.resolveNetworkAddresses }
                        : {}),
                });
                serviceBinding = bindConnectedAccountConfiguredOrigins(serviceBinding, resolution);
            }
            const services = params.createServices(seed, serviceBinding);
            const configuration: PluginConnectedAccountRuntimeConfiguration = Object.freeze({
                ...input.context.configuration,
                async getSecret(fieldId, options) {
                    await assertCurrent();
                    const value = await input.context.configuration.getSecret(fieldId, options);
                    await assertCurrent();
                    if (value !== null) params.registerRawForRedaction(seed, value);
                    return value;
                },
            });
            const attemptCredentials: PluginConnectedAccountCredentialStore = Object.freeze({
                async get(key: string, options?: Readonly<{ signal?: AbortSignal }>) {
                    await assertCurrent();
                    const value = await input.context.attemptCredentials.get(key, options);
                    await assertCurrent();
                    if (value !== null) params.registerRawForRedaction(seed, value);
                    return value;
                },
                async set(
                    key: string,
                    value: string,
                    options?: Readonly<{ signal?: AbortSignal }>,
                ) {
                    await assertCurrent();
                    await input.context.attemptCredentials.set(key, value, options);
                    await assertCurrent();
                    params.registerRawForRedaction(seed, value);
                },
                async delete(key: string, options?: Readonly<{ signal?: AbortSignal }>) {
                    await assertCurrent();
                    await input.context.attemptCredentials.delete(key, options);
                    await assertCurrent();
                },
            });
            const context: PluginConnectedAccountAuthenticationContext = Object.freeze({
                plugin: seed.plugin,
                contribution: seed.contribution,
                surface: seed.surface,
                invokedAtMs: lifetime.invokedAtMs,
                signal,
                services,
                ui: createPluginInvocationPresentation({
                    currentSession: null,
                    signal,
                    isOccurrenceCurrent: seed.isOccurrenceCurrent,
                }),
                ...input.context,
                configuration,
                attemptCredentials,
            });
            return Object.freeze({ owner: 'plugin', lease, context, assertCurrent, lifetime,
                registerRawForRedaction: (value: string) => params.registerRawForRedaction(seed, value),
                ...(params.redactDiagnosticText ? { redactDiagnosticText: (value: string) => params.redactDiagnosticText!(seed, value) } : {}),
            });
        } catch (error) {
            lifetime.complete();
            throw error;
        }
    }

    function assertSameAccount(
        left: ConnectedAccountRuntimeEstablishedTarget['account'],
        right: ConnectedAccountRuntimeEstablishedTarget['account'],
    ): void {
        if (!sameQualifiedConnectedAccountRef(left, right)) {
            throw new Error('Connected-account established context does not match its exact target');
        }
    }

    async function createEstablishedContext(
        input: ConnectedAccountRuntimeEstablishedInvocation,
    ): Promise<EstablishedInvocationContext> {
        assertSameAccount(input.target.account, input.context.account);
        const configurationTarget = input.context.configuration.target;
        if (
            configurationTarget.kind === 'attempt'
            || input.context.configuration.revision
                !== input.target.expectedRuntimeConfigurationRevision
        ) {
            throw new Error('Connected-account established configuration revision is unavailable');
        }
        if (configurationTarget.kind === 'account') {
            assertSameAccount(input.target.account, configurationTarget.account);
        } else if (!sameService(
            input.target.account.service,
            configurationTarget.service,
        )) {
            throw new Error('Connected-account established context does not match its exact service target');
        }

        const lease = await observeMaterializationPhase('runtime_registry', () => params.resolveRuntime(input.target.account.service));
        if (lease?.owner === 'host') {
            if (!sameService(lease.ref, input.target.account.service)) throw new Error('Connected-account established runtime is unavailable');
            const lifetime = createPluginInvocationLifetime(input.signal);
            const redaction = hostRedaction(lifetime);
            const assertCurrent = () => assertEstablishedAuthorityCurrent(input, lease, lifetime.signal);
            const assertFieldReadCurrent = () => assertEstablishedFieldReadCurrent(input, lease, lifetime.signal, assertCurrent);
            try {
                await assertCurrent();
                const context: HostConnectedAccountReadContext = Object.freeze({
                    ...input.context,
                    signal: lifetime.signal, invokedAtMs: lifetime.invokedAtMs,
                    configuration: guardConfiguration(input.context.configuration, assertFieldReadCurrent, redaction.registerRawForRedaction),
                    credentials: Object.freeze({ async get(key: string, options?: Readonly<{ signal?: AbortSignal }>) {
                        await assertFieldReadCurrent();
                        const value = await input.context.credentials.get(key, options);
                        await assertFieldReadCurrent();
                        if (value !== null) redaction.registerRawForRedaction(value);
                        return value;
                    } }),
                });
                return Object.freeze({
                    owner: 'host', lease, context, ...redaction,
                    assertCurrent, assertFieldReadCurrent, lifetime,
                });
            } catch (error) {
                await lifetime.complete();
                throw error;
            }
        }
        const plugin = lease ? params.resolvePlugin(lease.ref) : null;
        if (!lease || !plugin || !sameService(lease.ref, input.target.account.service)) {
            throw new Error('Connected-account established runtime is unavailable');
        }
        const lifetime = createPluginInvocationLifetime(input.signal);
        const signal = lifetime.signal;
        const qualifiedId = `${lease.ref.pluginId}/connectedAccountDescriptors/${lease.ref.localId}`;
        const seed: PluginInvocationServicesSeed = Object.freeze({
            plugin: Object.freeze({ id: lease.ref.pluginId, version: plugin.version }),
            contribution: Object.freeze({
                id: lease.ref.localId,
                qualifiedId,
            }),
            occurrenceId: lease.occurrenceId,
            sourceCustody: lease.sourceCustody,
            correlationId: randomUUID(),
            surface: 'cli',
            signal,
            redactionLifetimeSignal: lifetime.redactionLifetimeSignal,
            isOccurrenceCurrent: () => !signal.aborted && lease.isCurrent(),
        });
        const assertCurrent = async (
            _phase: ConnectedAccountCallbackCurrentnessPhase = 'afterCallback',
        ): Promise<void> => await assertEstablishedAuthorityCurrent(input, lease, signal);
        const assertFieldReadCurrent = () => assertEstablishedFieldReadCurrent(input, lease, signal, assertCurrent);
        try {
            await assertCurrent();
            const policy = params.resolveHostPolicy({
                pluginId: lease.ref.pluginId,
                occurrenceId: lease.occurrenceId,
                qualifiedId,
            }, {
                hostAccessRequests: plugin.hostAccessRequests,
                surface: 'cli',
                signal,
            });
            const hasQualifiedProducerNetworkAuthority = hasConnectedAccountOriginRequest(
                lease.ref.pluginId,
                lease.ref,
                plugin.hostAccessRequests,
            );
            let serviceBinding = policy.serviceBinding;
            if (hasQualifiedProducerNetworkAuthority) {
                const configurationRevocationSignal = input.configurationRevocationSignal?.(
                    input.context.configuration,
                );
                const resolution = await resolveConnectedAccountConfiguredOrigins({
                    pluginId: lease.ref.pluginId,
                    service: lease.ref,
                    occurrenceId: lease.occurrenceId,
                    configuration: input.context.configuration,
                    hostAccessRequests: resolveHostAccessEntries(
                        plugin.hostAccessRequests,
                        policy,
                    ),
                    resolveHostOwnedConfiguredEndpoints: async (configuration) => (
                        await params.resolveHostOwnedConfiguredEndpoints(lease.ref, configuration)
                    ),
                    isConfigurationCurrent: input.isConfigurationCurrent,
                    ...(configurationRevocationSignal === undefined
                        ? {}
                        : { configurationRevocationSignal }),
                    isOccurrenceCurrent: () => lease.isCurrent(),
                    ...(params.resolveNetworkAddresses
                        ? { resolveNetworkAddresses: params.resolveNetworkAddresses }
                        : {}),
                });
                serviceBinding = bindConnectedAccountConfiguredOrigins(serviceBinding, resolution);
            }
            await assertCurrent();
            const services = params.createServices(seed, serviceBinding);
            const credentials: ConnectedAccountCredentialReader = Object.freeze({
                async get(key: string, options?: Readonly<{ signal?: AbortSignal }>) {
                    await assertFieldReadCurrent();
                    const value = await input.context.credentials.get(key, options);
                    await assertFieldReadCurrent();
                    if (value !== null) params.registerRawForRedaction(seed, value);
                    return value;
                },
            });
            const configuration: PluginConnectedAccountRuntimeConfiguration = Object.freeze({
                ...input.context.configuration,
                async getSecret(fieldId, options) {
                    await assertFieldReadCurrent();
                    const value = await input.context.configuration.getSecret(fieldId, options);
                    await assertFieldReadCurrent();
                    if (value !== null) params.registerRawForRedaction(seed, value);
                    return value;
                },
            });
            const context: PluginConnectedAccountReadContext = Object.freeze({
                plugin: seed.plugin,
                contribution: seed.contribution,
                surface: seed.surface,
                invokedAtMs: lifetime.invokedAtMs,
                signal,
                services,
                ui: createPluginInvocationPresentation({
                    currentSession: null,
                    signal,
                    isOccurrenceCurrent: seed.isOccurrenceCurrent,
                }),
                account: input.context.account,
                configuration,
                credentials,
            });
            return Object.freeze({
                owner: 'plugin', lease, context, assertCurrent, assertFieldReadCurrent, lifetime,
                registerRawForRedaction: (value: string) => params.registerRawForRedaction(seed, value),
                ...(params.redactDiagnosticText ? { redactDiagnosticText: (value: string) => params.redactDiagnosticText!(seed, value) } : {}),
            });
        } catch (error) {
            lifetime.complete();
            throw error;
        }
    }

    function guardStagedCredentials(
        source: PluginConnectedAccountCredentialStore,
        assertCurrent: () => Promise<void>,
        registerRawForRedaction: (value: string) => void,
    ): PluginConnectedAccountCredentialStore {
        return Object.freeze({
            async get(key: string, options?: Readonly<{ signal?: AbortSignal }>) {
                await assertCurrent();
                const value = await source.get(key, options);
                await assertCurrent();
                if (value !== null) registerRawForRedaction(value);
                return value;
            },
            async set(
                key: string,
                value: string,
                options?: Readonly<{ signal?: AbortSignal }>,
            ) {
                await assertCurrent();
                await source.set(key, value, options);
                await assertCurrent();
                registerRawForRedaction(value);
            },
            async delete(key: string, options?: Readonly<{ signal?: AbortSignal }>) {
                await assertCurrent();
                await source.delete(key, options);
                await assertCurrent();
            },
        });
    }

    async function invokeAuthenticationMode<Context>(
        mode: ConnectedAccountAuthenticationModeRuntimeFor<Context> | undefined,
        context: Context,
        input: ConnectedAccountRuntimeAuthenticationInvocation,
        registerRawForRedaction: (value: string) => void,
        assertCurrent: () => Promise<void>,
    ): Promise<unknown> {
        if (!mode || mode.kind !== input.admission.descriptor.kind) {
            return authenticationUnavailable(
                'connected_account_authentication_mode_unavailable',
            );
        }
        const options = input.signal ? { signal: input.signal } : undefined;
        const operation = input.operation;
        let result: unknown;
        let invoked = false;
        switch (operation.kind) {
            case 'beginOAuth':
                if (mode.kind !== 'oauthAuthorizationCode') break;
                registerRawForRedaction(operation.request.state);
                result = await invokeCurrentConnectedAccountCallback(
                    assertCurrent,
                    () => mode.begin(operation.request, context, options),
                );
                invoked = true;
                break;
            case 'beginDevice':
                if (mode.kind !== 'oauthDeviceCode') break;
                result = await invokeCurrentConnectedAccountCallback(
                    assertCurrent,
                    () => mode.begin(context, options),
                );
                invoked = true;
                break;
            case 'submitManual':
                if (
                    mode.kind !== 'manual'
                    || input.admission.descriptor.kind !== 'manual'
                ) break;
                for (const field of input.admission.descriptor.fields) {
                    if (!field.secret) continue;
                    const value = operation.fields[field.id];
                    if (value !== undefined) {
                        registerRawForRedaction(value);
                    }
                }
                result = await invokeCurrentConnectedAccountCallback(
                    assertCurrent,
                    () => mode.complete(
                        Object.freeze({ fields: operation.fields }),
                        context,
                        options,
                    ),
                );
                invoked = true;
                break;
            case 'completeOAuth':
                if (mode.kind !== 'oauthAuthorizationCode') break;
                registerRawForRedaction(operation.completion.code);
                registerRawForRedaction(operation.completion.callbackUrl);
                registerRawForRedaction(operation.completion.state);
                registerRawForRedaction(operation.completion.pkceVerifier);
                result = await invokeCurrentConnectedAccountCallback(
                    assertCurrent,
                    () => mode.complete(operation.completion, context, options),
                );
                invoked = true;
                break;
            case 'pollDevice':
                if (mode.kind !== 'oauthDeviceCode') break;
                result = await invokeCurrentConnectedAccountCallback(
                    assertCurrent,
                    () => mode.poll(context, options),
                );
                invoked = true;
                break;
            case 'reconcile':
                if (typeof mode.reconcile !== 'function') break;
                result = await invokeCurrentConnectedAccountCallback(
                    assertCurrent,
                    () => mode.reconcile!(context, options),
                );
                invoked = true;
                break;
            case 'cancel':
                result = await invokeCurrentConnectedAccountCallback(
                    assertCurrent,
                    () => mode.kind === 'manual'
                        ? undefined
                        : mode.cancel(context),
                );
                invoked = true;
                break;
        }
        if (!invoked) {
            return authenticationUnavailable(
                'connected_account_authentication_operation_unavailable',
            );
        }

        return result;
    }

    async function invokeEstablishedRuntime<Context extends object, TOperation extends ConnectedAccountRuntimeEstablishedOperation>(
        runtime: ConnectedAccountEstablishedRuntimeFor<Context>,
        descriptor: ConnectedAccountRuntimeLease['descriptor'],
        context: Context,
        input: ConnectedAccountRuntimeEstablishedInvocation<TOperation>,
        registerRawForRedaction: (value: string) => void,
        assertCurrent: () => Promise<void>,
        assertFieldReadCurrent: () => Promise<void>,
        redactDiagnosticText?: (value: string) => string,
    ) {
        const options = input.signal ? { signal: input.signal } : undefined;
        const operation = input.operation;
        // Copy a terminal producer result before its final fresh qualification.
        // There is no authority-consuming step between callback settlement and
        // this copy; computed fields still cannot publish after revocation.
        const settleCallback = (callback: () => MaybePromise<unknown>, quotaLeafUnavailable = false) =>
            invokeCurrentConnectedAccountCallback(assertCurrent, callback, result =>
                snapshotConnectedAccountEstablishedResult(operation, result, {
                    quotaLeafUnavailable,
                    ...(redactDiagnosticText ? { redactDiagnosticText } : {}),
                }));
        let result: unknown;
        let quotaLeafUnavailable = false;
        switch (operation.kind) {
            case 'recoveryCredits.read':
            case 'recoveryCredits.consume': {
                const facet = descriptor.recoveryCredits?.supported === true
                    ? runtime.recoveryCredits
                    : undefined;
                quotaLeafUnavailable = !facet;
                return await settleCallback(async () => {
                    if (!facet) return null;
                    if (operation.kind === 'recoveryCredits.read') return await facet.read(context, options);
                    if (!operation.request.idempotencyKey.trim()) throw new Error('Recovery credit idempotency key is required');
                    return await facet.consume(Object.freeze({
                        idempotencyKey: operation.request.idempotencyKey.trim(),
                        ...(operation.request.providerLimitIds === undefined ? {} : { providerLimitIds: Object.freeze([...operation.request.providerLimitIds]) }),
                        ...(operation.request.providerCreditId?.trim()
                            ? { providerCreditId: operation.request.providerCreditId.trim() }
                            : {}),
                    }), context, options);
                }, quotaLeafUnavailable);
            }
            case 'refresh':
            case 'enrichCredentialContext':
                return await settleCallback(
                    async () => {
                        if (operation.kind === 'enrichCredentialContext' && !runtime.enrichCredentialContext) {
                            return { status: 'outcomeUnknown', diagnostic: {
                                code: 'connected_account_context_enrichment_unsupported',
                                message: 'This Connected Account runtime does not support credential context enrichment.',
                            } };
                        }
                        const mutationContext = Object.freeze({
                            ...context,
                            operation: Object.freeze({
                                operationId: operation.operationId,
                                configurationRevision:
                                    input.target.expectedRuntimeConfigurationRevision,
                            }),
                            stagedCredentials: guardStagedCredentials(
                                operation.stagedCredentials,
                                assertFieldReadCurrent,
                                (value) => registerRawForRedaction(value),
                            ),
                        });
                        return operation.kind === 'refresh'
                            ? await runtime.refresh(mutationContext, options)
                            : await runtime.enrichCredentialContext!(mutationContext, options);
                    },
                );
            case 'status':
                return await settleCallback(
                    () => runtime.status(context, options),
                );
            case 'quota':
                if (runtime.quota) {
                    const quota = await invokeCurrentConnectedAccountCallback(
                        assertCurrent,
                        () => runtime.quota!(context, options),
                    );
                    // Quota output has no recovery authority. Only the admitted,
                    // explicitly declared facet may contribute reset inventory.
                    const base = {
                        observedAtMs: quota.observedAtMs,
                        limits: quota.limits,
                        ...(quota.providerOrganizationId === undefined ? {} : { providerOrganizationId: quota.providerOrganizationId }),
                        ...(quota.planLabel === undefined ? {} : { planLabel: quota.planLabel }),
                        ...(quota.subscription === undefined ? {} : { subscription: quota.subscription }),
                    };
                    result = base;
                    const facet = descriptor.recoveryCredits?.supported === true
                        ? runtime.recoveryCredits : undefined;
                    if (facet) {
                        try {
                            const inventory = await invokeCurrentConnectedAccountCallback(
                                assertCurrent, () => facet.read(context, options),
                            );
                            const recoveryCredits = ConnectedServiceQuotaRecoveryCreditsV1Schema.parse({
                                availableCount: inventory.availableCount,
                                credits: inventory.credits.map(({ providerCreditId, status, kind, ...metadata }) => ({
                                    ...metadata,
                                    id: providerCreditId,
                                    kind: kind ?? 'usage_limit_reset',
                                    status: status === 'unavailable' ? 'unknown' : status,
                                })),
                            });
                            const recoveryCreditDetails = inventory.recoveryCreditDetails === undefined ? undefined
                                : ConnectedServiceQuotaRecoveryCreditDetailsByIdV1Schema.parse(inventory.recoveryCreditDetails);
                            result = { ...base, recoveryCredits,
                                ...(recoveryCreditDetails === undefined ? {} : { recoveryCreditDetails }),
                            };
                        } catch {
                            // A failed ancillary read removes actionable inventory;
                            // provider text is never included in the default signal.
                            logger.info('[ConnectedAccounts] recovery credit inventory unavailable', {
                                service: input.target.account.service,
                            });
                            await assertCurrent();
                        }
                    }
                } else {
                    quotaLeafUnavailable = true;
                    result = await invokeCurrentConnectedAccountCallback(assertCurrent, () => null);
                }
                break;
            case 'revoke':
                return await settleCallback(
                    () => runtime.revoke(context, options),
                );
            case 'materialize':
                return await settleCallback(
                    () => runtime.materialize(
                        operation.request,
                        context,
                        { ...options, ...(operation.existingFiles ? { existingFiles: operation.existingFiles } : {}) },
                    ),
                );
        }

        const snapshot = snapshotConnectedAccountEstablishedResult(operation, result, {
            quotaLeafUnavailable,
            ...(redactDiagnosticText ? { redactDiagnosticText } : {}),
        });
        await assertCurrent();
        return snapshot;
    }

    return Object.freeze({
        async invokeAuthentication(input) {
            let invocation: AuthenticationInvocationContext;
            try {
                invocation = await createContext(input);
            } catch (error) {
                if (error instanceof ConnectedAccountRuntimeInvocationNotStartedError) throw error;
                return authenticationUnavailable('connected_account_producer_context_unavailable');
            }
            try {
                const result = invocation.owner === 'host'
                    ? await invokeAuthenticationMode(
                        invocation.lease.runtime.authentication.modes[input.admission.modeId],
                        invocation.context, input, invocation.registerRawForRedaction, invocation.assertCurrent,
                    )
                    : await invokeAuthenticationMode(
                        invocation.lease.runtime.authentication.modes[input.admission.modeId],
                        invocation.context, input, invocation.registerRawForRedaction, invocation.assertCurrent,
                    );
                const output = snapshotConnectedAccountAuthenticationResult(
                    result,
                    invocation.redactDiagnosticText,
                );
                await invocation.assertCurrent();
                return output;
            } finally {
                await invocation.lifetime.complete();
            }
        },
        async invokeEstablished<TOperation extends ConnectedAccountRuntimeEstablishedOperation>(
            input: ConnectedAccountRuntimeEstablishedInvocation<TOperation>,
        ): Promise<ConnectedAccountRuntimeEstablishedResult<TOperation>> {
            const invocation = await createEstablishedContext(input);
            try {
                return invocation.owner === 'host'
                    ? await invokeEstablishedRuntime(
                        invocation.lease.runtime, invocation.lease.descriptor, invocation.context,
                        input, invocation.registerRawForRedaction, invocation.assertCurrent,
                        invocation.assertFieldReadCurrent,
                        invocation.redactDiagnosticText,
                    )
                    : await invokeEstablishedRuntime(
                        invocation.lease.runtime, invocation.lease.descriptor, invocation.context,
                        input, invocation.registerRawForRedaction, invocation.assertCurrent,
                        invocation.assertFieldReadCurrent,
                        invocation.redactDiagnosticText,
                    );
            } finally {
                await invocation.lifetime.complete();
            }
        },
    });
}
