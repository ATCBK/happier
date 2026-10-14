import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import type { PluginRegistrationValueByFamily } from '../../registration/valueByFamily.js';
import type { AgentPreflightSessionControlsContributionV1 } from '../../agentRuntime/index.js';
import type { PluginConnectedAccountRuntime } from '../../services/index.js';
import type { RegisteredVoiceProviderRuntime } from '../../voice/projections.js';
import { createPluginRegistrationScope } from './scope.js';
import { snapshotManagedProviderRuntime, snapshotStaticRegistrationValue } from './staticRegistrationSnapshots.js';

type AccountMode = PluginConnectedAccountRuntime['authentication']['modes'][string];
type Callbacks<T> = Pick<T, {
    [K in keyof T]-?: NonNullable<T[K]> extends (...args: never[]) => unknown ? K : never;
}[keyof T]>;
type AccountWithMode<K extends AccountMode['kind']> = Omit<PluginConnectedAccountRuntime, 'authentication'> & {
    authentication: { modes: { auth: Extract<AccountMode, { kind: K }> } };
};

// These are references to the contract owners, never a copy of their method names.
type SnapshotContracts = {
    scmBackends: PluginRegistrationValueByFamily['scmBackends'];
    scmRuntimeDescriptor: NonNullable<PluginRegistrationValueByFamily['scmBackends']['runtime']>;
    scmHostingProviders: PluginRegistrationValueByFamily['scmHostingProviders'];
    mcp: PluginRegistrationValueByFamily['mcp.servers'];
    projectNativeAdapters: PluginRegistrationValueByFamily['projectNativeAdapters'];
    composerAttachments: PluginRegistrationValueByFamily['composerAttachments'];
    composerReferences: PluginRegistrationValueByFamily['composerReferences'];
    resources: PluginRegistrationValueByFamily['resources'];
    dragSources: PluginRegistrationValueByFamily['dragSources'];
    dropTargets: PluginRegistrationValueByFamily['dropTargets'];
    captureSources: PluginRegistrationValueByFamily['captureSources'];
    speech: Extract<RegisteredVoiceProviderRuntime, { kind: 'speech' }>;
    conversation: Extract<RegisteredVoiceProviderRuntime, { kind: 'conversation' }>;
    manualAccount: AccountWithMode<'manual'>;
    oauthAccount: AccountWithMode<'oauthAuthorizationCode'>;
    deviceAccount: AccountWithMode<'oauthDeviceCode'>;
    managedProvider: NonNullable<PluginRegistrationValueByFamily['providers']['managedRuntime']>;
    externalSessions: NonNullable<PluginRegistrationValueByFamily['agents']['externalSessions']>;
    externalSessionObservation: NonNullable<PluginRegistrationValueByFamily['agents']['externalSessionObservation']>;
    preflightCallbacks: Callbacks<AgentPreflightSessionControlsContributionV1>;
};

// Compiler API inspection only: no emit, semantic diagnostics or package typecheck.
// Resolve current source, including imported/inherited and optional members.
const testPath = fileURLToPath(import.meta.url);
const program = ts.createProgram([testPath], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
    customConditions: ['happier-source'],
});
const checker = program.getTypeChecker();
const source = program.getSourceFile(testPath)!;
const contractsDeclaration = source.statements.find((statement): statement is ts.TypeAliasDeclaration => (
    ts.isTypeAliasDeclaration(statement) && statement.name.text === 'SnapshotContracts'
))!;
const contracts = checker.getTypeAtLocation(contractsDeclaration);

type CallbackWitness = { path: string[]; receiver: object; callback: (...args: unknown[]) => unknown };
type Seeds = Readonly<Record<string, unknown>>;

function fixtureFromContract(type: ts.Type, seeds: Seeds, witnesses: CallbackWitness[], path: string[] = []): object {
    const fixture: Record<string, unknown> = {};
    const members = checker.getPropertiesOfType(checker.getNonNullableType(type));
    expect(members.length, `Unresolved contract at ${path.join('.')}`).toBeGreaterThan(0);
    for (const member of members) {
        const name = member.name;
        const memberPath = [...path, name];
        const key = memberPath.join('.');
        const memberType = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(member, contractsDeclaration));
        if (memberType.getCallSignatures().length > 0) {
            // Real executable leaves, not mocks of internal snapshot logic. Return
            // receiver/args so the assertion observes capture semantics directly.
            const callback = function (this: object, ...args: unknown[]) { return { receiver: this, args }; };
            fixture[name] = callback;
            witnesses.push({ path: memberPath, receiver: fixture, callback });
        } else if (Object.hasOwn(seeds, key)) {
            fixture[name] = seeds[key];
        } else if (memberType.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) {
            fixture[name] = fixtureFromContract(memberType, seeds, witnesses, memberPath);
        } else {
            throw new Error(`Supply static data for contract member ${key}`);
        }
    }
    return fixture;
}

function readPath(value: unknown, path: readonly string[]): unknown {
    for (const member of path) {
        if (typeof value !== 'object' || value === null) return undefined;
        value = Reflect.get(value, member);
    }
    return value;
}

function capture<K extends keyof PluginRegistrationValueByFamily>(family: K, fixture: object): unknown {
    // Synthetic fixtures deliberately return receiver witnesses, not domain results.
    return snapshotStaticRegistrationValue(family, fixture as PluginRegistrationValueByFamily[K]);
}

function captureAgentField(field: 'externalSessions' | 'externalSessionObservation', fixture: object): unknown {
    const scope = createPluginRegistrationScope({
        pluginId: 'test.snapshot-contract',
        target: { realm: 'daemon' },
        rights: [{ family: 'agents', localId: 'agent', target: { realm: 'daemon' }, requiredFields: ['externalSessions'] }],
    });
    if (field === 'externalSessions') {
        scope.api.agents.registerExternalSessions('agent', fixture as SnapshotContracts['externalSessions']);
    } else {
        const externalType = checker.getTypeOfSymbolAtLocation(checker.getPropertyOfType(contracts, 'externalSessions')!, contractsDeclaration);
        scope.api.agents.registerExternalSessions('agent', fixtureFromContract(externalType, {}, []) as SnapshotContracts['externalSessions']);
        scope.api.agents.registerExternalSessionObservation('agent', fixture as SnapshotContracts['externalSessionObservation']);
    }
    const [registration] = scope.commit();
    expect(registration?.family).toBe('agents');
    return readPath(registration?.value, [field]);
}

function capturePreflightCallbacks(fixture: object): unknown {
    const scope = createPluginRegistrationScope({
        pluginId: 'test.snapshot-contract', target: { realm: 'daemon' },
        rights: [{ family: 'agents', localId: 'agent', target: { realm: 'daemon' }, requiredFields: ['factory'] }],
    });
    scope.api.agents.register('agent', () => ({ sessions: { open: async () => { throw new Error('Not opened by registration'); } } }), {
        preflightSessionControls: fixture as SnapshotContracts['preflightCallbacks'],
    });
    return readPath(scope.commit()[0]?.value, ['preflightSessionControls']);
}

type Case = { contract: keyof SnapshotContracts; capture(fixture: object): unknown; seeds?: Seeds };
const cases: Case[] = [
    { contract: 'scmBackends', capture: (fixture) => capture('scmBackends', fixture), seeds: {
        runtime: { repoModes: ['.git'], capabilities: {}, commands: {} },
    } },
    { contract: 'scmHostingProviders', capture: (fixture) => capture('scmHostingProviders', fixture), seeds: {
        'adapter.pullRequests.supportsDraftCreate': true,
    } },
    { contract: 'mcp', capture: (fixture) => capture('mcp.servers', fixture) },
    ...(['projectNativeAdapters', 'composerAttachments', 'composerReferences', 'resources', 'dragSources', 'dropTargets', 'captureSources'] as const)
        .map((family) => ({ contract: family, capture: (fixture: object) => capture(family, fixture) })),
    { contract: 'speech', capture: (fixture) => capture('voiceProviders', fixture), seeds: { kind: 'speech' } },
    { contract: 'conversation', capture: (fixture) => capture('voiceProviders', fixture), seeds: {
        kind: 'conversation', microphoneMode: 'provider_managed', outputLevelMeter: 'measured',
    } },
    ...([
        ['manualAccount', 'manual'], ['oauthAccount', 'oauthAuthorizationCode'], ['deviceAccount', 'oauthDeviceCode'],
    ] as const).map(([contract, kind]) => ({
        contract, capture: (fixture: object) => capture('connectedAccountDescriptors', fixture),
        seeds: { 'authentication.modes.auth.kind': kind },
    })),
    { contract: 'managedProvider', capture: (fixture) => snapshotManagedProviderRuntime(fixture as SnapshotContracts['managedProvider']) },
    { contract: 'externalSessions', capture: (fixture) => captureAgentField('externalSessions', fixture) },
    { contract: 'externalSessionObservation', capture: (fixture) => captureAgentField('externalSessionObservation', fixture) },
    { contract: 'preflightCallbacks', capture: capturePreflightCallbacks },
];

describe('registration snapshots against current declared contracts', () => {
    it('retains every declared SCM runtime descriptor member', () => {
        const symbol = checker.getPropertyOfType(contracts, 'scmRuntimeDescriptor')!;
        const type = checker.getTypeOfSymbolAtLocation(symbol, contractsDeclaration);
        const runtime = Object.fromEntries(checker.getPropertiesOfType(type).map((member) => [member.name, []]));
        const snapshot = capture('scmBackends', { handlers: {}, runtime });
        expect(readPath(snapshot, ['runtime'])).toEqual(runtime);
        expect(Object.isFrozen(readPath(snapshot, ['runtime']))).toBe(true);
    });
    it.each(cases)('captures every $contract member without changing callback custody', ({ contract, capture, seeds = {} }) => {
        const symbol = checker.getPropertyOfType(contracts, contract)!;
        const type = checker.getTypeOfSymbolAtLocation(symbol, contractsDeclaration);
        const witnesses: CallbackWitness[] = [];
        const fixture = fixtureFromContract(type, seeds, witnesses);
        const snapshot = capture(fixture);
        expect(snapshot).toBeDefined();
        expect(Object.isFrozen(snapshot)).toBe(true);
        for (const { path, receiver, callback } of witnesses) {
            const captured = readPath(snapshot, path);
            expect(typeof captured, `Dropped declared callback ${contract}.${path.join('.')}`).toBe('function');
            expect(Object.isFrozen(readPath(snapshot, path.slice(0, -1)))).toBe(true);
            expect(Reflect.apply(captured as (...args: unknown[]) => unknown, {}, ['argument'])).toEqual({ receiver, args: ['argument'] });
            Reflect.set(receiver, path.at(-1)!, () => 'replaced');
            expect(Reflect.apply(captured as (...args: unknown[]) => unknown, {}, [])).toEqual(Reflect.apply(callback, receiver, []));
        }
        for (const [key, data] of Object.entries(seeds)) {
            expect(readPath(snapshot, key.split('.')), `Dropped declared data ${contract}.${key}`).toEqual(data);
        }
    });
});
