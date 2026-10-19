import { describe, expect, it, vi } from 'vitest';

import type { MachineAgent } from '@/agents/machineAgents/machineAgentTypes';
import { resolveMachineAgentState } from '@/agents/machineAgents/resolveMachineAgentState';
import {
    getSelectableBackendEntriesForNewSession,
    getSelectableAgentIdsForNewSession,
    isBackendEntrySelectableForNewSession,
    isAgentSelectableForNewSession,
    resolveNextSelectableBackendEntryForNewSession,
    resolveNextSelectableAgentForNewSession,
    resolveBackendEntryUnavailabilityReasonForNewSession,
    resolveProfileAvailabilityForNewSession,
    resolveAgentLaunchBlockedReasonForNewSession,
    type NewSessionSelectableBackendEntry,
} from './newSessionAgentSelection';
import { beginAcpCatalogLoad, getAcpCatalogSnapshot, applyAcpCatalogSnapshot } from '@/sync/store/settings/acpCatalogSnapshot';

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

function createMachineAgent(agentId: MachineAgent['agentId'], overrides: Partial<MachineAgent> = {}): MachineAgent {
    const agent: MachineAgent = {
        agentId, title: agentId, state: 'ready', stale: false, installed: true,
        version: null, latestVersion: null, update: null,
        signIn: { status: 'signedIn', via: null, nativeLogin: 'unsupported', connectedServices: [] },
        platform: { supported: true },
        install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null, requiresVendorConsent: false },
        dependencies: [], job: null, ...overrides,
    };
    return { ...agent, state: overrides.state ?? resolveMachineAgentState(agent) };
}

const claudeEntry: NewSessionSelectableBackendEntry = {
    backendTarget: { kind: 'backend', backendId: 'claude' }, backendTargetKey: 'agent:happier.agent.claude/claude',
    builtInAgentId: 'claude', agentId: 'claude', kind: 'builtInAgent',
};
const codexEntry: NewSessionSelectableBackendEntry = {
    backendTarget: { kind: 'backend', backendId: 'codex' }, backendTargetKey: 'agent:happier.agent.codex/codex',
    builtInAgentId: 'codex', agentId: 'codex', kind: 'builtInAgent',
};
const configuredEntry: NewSessionSelectableBackendEntry = {
    backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
    backendTargetKey: 'backend:review-bot:configured:review-bot',
    builtInAgentId: null, agentId: 'review-bot', kind: 'configuredBackend',
};

describe('newSessionAgentSelection', () => {
    it('keeps a known installed Agent selectable while required sign-in is unknown', () => {
        const agent = createMachineAgent('codex', { state: 'unknown',
            signIn: { status: 'unknown', via: null, nativeLogin: 'terminal', connectedServices: [] } });
        expect(isAgentSelectableForNewSession({ agentId: 'codex', machineAgentsById: { codex: agent } })).toBe(true);
        expect(resolveAgentLaunchBlockedReasonForNewSession({ backendTarget: codexEntry.backendTarget,
            selectedBackendEntry: codexEntry, projectionPhase: 'ready', acpCatalog: null, agentLabel: 'Codex',
            selectedCredentialMachineAgent: agent, machineAgentsStatus: 'ready', agentStartBlock: null })).not.toBeNull();
    });
    it.each(['external', 'configured', 'legacyConfigured'] as const)('keeps an unresolved %s target checking only while its catalog is loading', (kind) => {
        const scope = { serverId: `new-session-${kind}`, accountId: 'readiness-test' };
        beginAcpCatalogLoad(scope);
        const backendTarget = kind === 'external'
            ? { kind: 'agent' as const, identity: { pluginId: 'acme.review', localId: 'review' } }
            : kind === 'configured'
                ? { kind: 'agent' as const, identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId: 'review' }
                : { kind: 'backend' as const, backendId: 'review', configuredBackendId: 'review' };
        const params = {
            backendTarget, selectedBackendEntry: null,
            projectionPhase: kind === 'external' ? 'loading' as const : 'ready' as const,
            acpCatalog: getAcpCatalogSnapshot(scope)!.catalog,
            agentLabel: 'Review', selectedCredentialMachineAgent: null,
            machineAgentsStatus: 'ready' as const, agentStartBlock: null,
        };
        expect(resolveAgentLaunchBlockedReasonForNewSession(params)).toBe('machineAgents.checking');
        applyAcpCatalogSnapshot(scope, { status: 'unavailable', reason: 'unauthorized' }, true);
        expect(resolveAgentLaunchBlockedReasonForNewSession({
            ...params, projectionPhase: 'error', acpCatalog: getAcpCatalogSnapshot(scope)!.catalog,
        })).toBe('newSession.selectAiBackendTitle');
        // Loading the other catalog cannot turn a settled missing target into
        // a check in progress: each target has one availability authority.
        expect(resolveAgentLaunchBlockedReasonForNewSession({
            ...params,
            projectionPhase: kind === 'external' ? 'ready' : 'loading',
            acpCatalog: kind === 'external' ? { status: 'loading' } : getAcpCatalogSnapshot(scope)!.catalog,
        })).toBe('newSession.selectAiBackendTitle');
    });

    it('does not withdraw a ready bundled target while unrelated catalogs load', () => {
        expect(resolveAgentLaunchBlockedReasonForNewSession({
            backendTarget: codexEntry.backendTarget, selectedBackendEntry: codexEntry,
            projectionPhase: 'loading', acpCatalog: { status: 'loading' },
            agentLabel: 'Codex', selectedCredentialMachineAgent: createMachineAgent('codex'),
            machineAgentsStatus: 'ready', agentStartBlock: null,
        })).toBeNull();
    });
    it('fails closed before the selected machine has been checked', () => {
        expect(isAgentSelectableForNewSession({ agentId: 'codex', machineAgentsById: {} })).toBe(false);
    });

    it('does not select Antigravity when its dependency exists but its own CLI is missing', () => {
        expect(isAgentSelectableForNewSession({
            agentId: 'antigravity',
            machineAgentsById: { antigravity: createMachineAgent('antigravity', {
                installed: false,
                dependencies: [{ key: 'dep.antigravity-acp', title: 'ACP server', installed: true, version: '1.0.0' }],
            }) },
        })).toBe(false);
    });

    it.each([
        ['missing dependency', { dependencies: [{ key: 'dep.acp', title: 'ACP server', installed: false, version: null }] }],
        ['stale', { stale: true }],
        ['checking', { state: 'checking' }],
        ['unknown inventory', { state: 'unknown' }],
        ['installing', { state: 'installing' }],
        ['failed', { state: 'failed' }],
        ['unsupported', { platform: { supported: false, reason: 'arch' } }],
    ] satisfies ReadonlyArray<readonly [string, Partial<MachineAgent>]>)('does not select an agent that is %s', (_label, overrides) => {
        expect(isAgentSelectableForNewSession({
            agentId: 'codex', machineAgentsById: { codex: createMachineAgent('codex', overrides) },
        })).toBe(false);
    });

    it('trusts canonical readiness when the installed Agent has an unknown sign-in status', () => {
        expect(isAgentSelectableForNewSession({
            agentId: 'codex',
            machineAgentsById: { codex: createMachineAgent('codex', {
                state: 'ready',
                signIn: { status: 'unknown', via: null, nativeLogin: 'unsupported', connectedServices: [] },
            }) },
        })).toBe(true);
    });

    it('accepts ready and update-available rows through the same list and cycling policy', () => {
        const machineAgentsById = {
            claude: createMachineAgent('claude'), codex: createMachineAgent('codex', { installed: false }),
            opencode: createMachineAgent('opencode', {
                version: '1.0.0', latestVersion: '2.0.0', update: { supported: true, command: 'update' },
            }),
        };
        expect(getSelectableAgentIdsForNewSession({
            candidateAgentIds: ['claude', 'codex', 'opencode'], machineAgentsById,
        })).toEqual(['claude', 'opencode']);
        expect(resolveNextSelectableAgentForNewSession({
            candidateAgentIds: ['claude', 'codex', 'opencode'], currentAgentId: 'claude', machineAgentsById,
        })).toBe('opencode');
        expect(resolveNextSelectableAgentForNewSession({
            candidateAgentIds: ['claude', 'codex', 'opencode'], currentAgentId: 'opencode', machineAgentsById,
        })).toBe('claude');
        expect(resolveNextSelectableAgentForNewSession({
            candidateAgentIds: ['claude', 'codex', 'opencode'], currentAgentId: 'codex', machineAgentsById,
        })).toBe('opencode');
    });

    it('does not offer a next agent when no inventory row is ready', () => {
        expect(resolveNextSelectableAgentForNewSession({
            candidateAgentIds: ['claude', 'codex'], currentAgentId: 'claude', machineAgentsById: {},
        })).toBeNull();
    });

    it('marks profiles available only when a compatible inventory row remains ready', () => {
        expect(resolveProfileAvailabilityForNewSession({
            candidateBackendEntries: [claudeEntry, codexEntry],
            machineAgentsById: { claude: createMachineAgent('claude', { installed: false }), codex: createMachineAgent('codex') },
        })).toEqual({ available: true });
        expect(resolveProfileAvailabilityForNewSession({
            candidateBackendEntries: [claudeEntry, codexEntry], machineAgentsById: {},
        })).toEqual({ available: false, reason: 'agent-not-ready:any' });
    });

    it('does not describe unknown or stale inventory as a missing CLI and still fails closed', () => {
        for (const agent of [
            undefined,
            createMachineAgent('codex', { state: 'unknown', stale: true }),
            createMachineAgent('codex', { stale: true }),
            createMachineAgent('codex', { dependencies: [{ key: 'dep.acp', title: 'ACP server', installed: false, version: null }] }),
        ]) {
            const machineAgentsById = { codex: agent };
            expect(resolveBackendEntryUnavailabilityReasonForNewSession({ entry: codexEntry, machineAgentsById }))
                .toBe('agent-not-ready:codex');
            expect(isBackendEntrySelectableForNewSession({ entry: codexEntry, machineAgentsById })).toBe(false);
        }
        expect(resolveBackendEntryUnavailabilityReasonForNewSession({
            entry: codexEntry, machineAgentsById: { codex: createMachineAgent('codex', { installed: false }) },
        })).toBe('cli-not-detected:codex');
    });

    it('allows choosing installed signed-out Agents and compatible Profiles before admitting launch credentials', () => {
        const machineAgentsById = {
            claude: createMachineAgent('claude', { state: 'needsSignIn' }),
            codex: createMachineAgent('codex', { state: 'needsSignIn' }),
        };
        expect(isAgentSelectableForNewSession({ agentId: 'claude', machineAgentsById })).toBe(true);
        expect(getSelectableBackendEntriesForNewSession({
            candidateBackendEntries: [claudeEntry, codexEntry], machineAgentsById,
        })).toEqual([claudeEntry, codexEntry]);
        expect(resolveNextSelectableBackendEntryForNewSession({
            candidateBackendEntries: [claudeEntry, codexEntry], currentTargetKey: claudeEntry.backendTargetKey, machineAgentsById,
        })).toEqual(codexEntry);
        expect(resolveProfileAvailabilityForNewSession({
            candidateBackendEntries: [codexEntry], machineAgentsById,
        })).toEqual({ available: true });
        expect(resolveProfileAvailabilityForNewSession({
            candidateBackendEntries: [claudeEntry, codexEntry], machineAgentsById,
        })).toEqual({ available: true });
    });

    it.each([
        { installed: false },
        { dependencies: [{ key: 'dep.acp', title: 'ACP server', installed: false, version: null }] },
        { platform: { supported: false, reason: 'arch' } },
        { stale: true },
    ] satisfies ReadonlyArray<Partial<MachineAgent>>)('never treats sign-out as a bypass for executable eligibility (%j)', (overrides) => {
        expect(isBackendEntrySelectableForNewSession({ entry: claudeEntry,
            machineAgentsById: { claude: createMachineAgent('claude', { ...overrides, state: 'needsSignIn' }) },
        })).toBe(false);
    });

    it('keeps configured ACP targets selectable without Agent inventory', () => {
        expect(isBackendEntrySelectableForNewSession({ entry: configuredEntry, machineAgentsById: {} })).toBe(true);
        expect(resolveProfileAvailabilityForNewSession({
            candidateBackendEntries: [configuredEntry], machineAgentsById: {},
        })).toEqual({ available: true });
        expect(resolveNextSelectableBackendEntryForNewSession({
            candidateBackendEntries: [claudeEntry, configuredEntry], currentTargetKey: claudeEntry.backendTargetKey,
            machineAgentsById: {},
        })).toEqual(configuredEntry);
    });

    it('requires the contributed Agent inventory row for plugin backends', () => {
        const entry: NewSessionSelectableBackendEntry = {
            backendTarget: { kind: 'backend', backendId: 'acme.review' }, backendTargetKey: 'backend:acme.review',
            builtInAgentId: null, agentId: 'acme.review/assistant', kind: 'pluginBackend',
        };
        expect(isBackendEntrySelectableForNewSession({ entry, machineAgentsById: {} })).toBe(false);
        expect(isBackendEntrySelectableForNewSession({
            entry, machineAgentsById: { 'acme.review/assistant': createMachineAgent('acme.review/assistant') },
        })).toBe(true);
    });

    it('excludes targets that explicitly do not support session runtime', () => {
        const entry = { ...configuredEntry, capabilities: { session: { supported: false }, executionRun: { supported: true } } };
        expect(getSelectableBackendEntriesForNewSession({ candidateBackendEntries: [entry], machineAgentsById: {} })).toEqual([]);
        expect(resolveProfileAvailabilityForNewSession({ candidateBackendEntries: [entry], machineAgentsById: {} }))
            .toEqual({ available: false, reason: 'no-supported-cli' });
    });
});
