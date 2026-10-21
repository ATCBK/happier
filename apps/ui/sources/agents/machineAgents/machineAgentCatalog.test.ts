import { describe, expect, it } from 'vitest';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { buildMachineAgentInventoryDescriptors, findMachineAgentForBackendTarget, findMachineAgentForBackendTargetKey } from './machineAgentCatalog';

describe('machine agent catalog', () => {
    it('revalidates new raw targets and does not trust a frozen carrier with mutable identity', () => {
        const agents = Object.freeze([
            Object.freeze({ agentId: 'acme.review/reviewer', title: 'Reviewer' }),
            Object.freeze({ agentId: 'acme.review/other', title: 'Other' }),
        ]);
        const identity = { pluginId: 'acme.review', localId: 'reviewer' };
        const target = Object.freeze({ kind: 'agent' as const, identity });
        expect(findMachineAgentForBackendTarget(agents, target)).toBe(agents[0]);
        identity.localId = 'other';
        expect(findMachineAgentForBackendTarget(agents, target)).toBe(agents[1]);
        identity.localId = '';
        expect(findMachineAgentForBackendTarget(agents, target)).toBeNull();
        expect(findMachineAgentForBackendTarget(agents, 'agent:malformed')).toBeNull();
        expect(findMachineAgentForBackendTarget(agents, { kind: 'backend', backendId: 'not:an:agent' })).toBeNull();
        expect(findMachineAgentForBackendTarget(agents, { kind: 'agent', identity: { pluginId: 'acme.absent', localId: 'reviewer' } })).toBeNull();
    });

    it('normalizes immutable inventory candidates once across repeated option lookups and refreshes by identity', () => {
        let candidateReads = 0;
        const agents = Object.freeze(Array.from({ length: 16 }, (_, index) => new Proxy(Object.freeze({
            agentId: `acme.review/agent-${index}`, title: `Agent ${index}`,
        }), { get(target, key, receiver) {
            if (key === 'agentId') candidateReads += 1;
            return Reflect.get(target, key, receiver);
        } })));
        const start = performance.now();
        for (let render = 0; render < 5; render += 1) {
            for (let index = 0; index < agents.length; index += 1) {
                expect(findMachineAgentForBackendTarget(agents, `agent:acme.review/agent-${index}`)).toBe(agents[index]);
            }
        }
        const reads = candidateReads;
        console.info('FX86 inventory lookup', { lookups: 80, candidateReads: reads, elapsedMs: performance.now() - start });
        expect(reads).toBe(agents.length);
        const replacement = Object.freeze([Object.freeze({ agentId: 'acme.review/replacement', title: 'Replacement' })]);
        expect(findMachineAgentForBackendTarget(replacement, 'agent:acme.review/agent-0')).toBeNull();
        expect(findMachineAgentForBackendTarget(replacement, 'agent:acme.review/replacement')).toBe(replacement[0]);
        // Readonly typing or a frozen array alone does not make candidate identities immutable.
        const mutable = { agentId: 'acme.review/old', title: 'Mutable' };
        const shallowFrozen = Object.freeze([mutable]);
        expect(findMachineAgentForBackendTarget(shallowFrozen, 'agent:acme.review/old')).toBe(mutable);
        mutable.agentId = 'acme.review/new';
        expect(findMachineAgentForBackendTarget(shallowFrozen, 'agent:acme.review/old')).toBeNull();
        expect(findMachineAgentForBackendTarget(shallowFrozen, 'agent:acme.review/new')).toBe(mutable);
        let currentId = 'acme.review/getter-old';
        const accessorInventory = Object.freeze([Object.freeze({ get agentId() { return currentId; } })]);
        expect(findMachineAgentForBackendTarget(accessorInventory, 'agent:acme.review/getter-old')).toBe(accessorInventory[0]);
        currentId = 'acme.review/getter-new';
        expect(findMachineAgentForBackendTarget(accessorInventory, 'agent:acme.review/getter-old')).toBeNull();
        expect(findMachineAgentForBackendTarget(accessorInventory, 'agent:acme.review/getter-new')).toBe(accessorInventory[0]);
    });
    it('lists only registry agents that declare session capabilities, including disabled and qualified plugin agents', () => {
        expect(buildMachineAgentInventoryDescriptors({ pluginProjectionV2: { agentsById: {
            'plugin/agent': { id: 'agent', title: 'Agent', providerOwnedEnvironmentKeys: [], capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } },
            helper: { id: 'helper', title: 'Helper', providerOwnedEnvironmentKeys: [], capabilities: { surfaces: [] } },
        } } })).toEqual([{ agentId: 'plugin/agent', title: 'Agent' }]);
        expect(buildMachineAgentInventoryDescriptors(null)).toEqual([]);
    });
    it('keeps configured definitions distinct from each other and from ordinary Agent identities', () => {
        const agents = buildMachineAgentInventoryDescriptors({ pluginProjectionV2: { agentsById: {
            'custom-acp': { id: 'custom-acp', title: 'Custom ACP', providerOwnedEnvironmentKeys: [],
                capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } },
            'acme.review/reviewer': { id: 'reviewer', title: 'External reviewer', providerOwnedEnvironmentKeys: [],
                capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } },
        } }, definitions: [{ definitionId: 'first', title: 'First' }, { definitionId: 'second', title: 'Second' }] });
        const target = { kind: 'agent' as const, identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: 'second' };
        expect(findMachineAgentForBackendTarget(agents, target)).toBe(agents[3]);
        expect(findMachineAgentForBackendTarget(agents, buildBackendTargetKeyV2(target))).toBe(agents[3]);
        expect(findMachineAgentForBackendTargetKey(agents, buildBackendTargetKeyV2(target))).toBe(agents[3]);
        expect(findMachineAgentForBackendTarget(agents, { kind: 'agent', identity: { pluginId: 'acme.review', localId: 'reviewer' } })).toBe(agents[1]);
        expect(findMachineAgentForBackendTargetKey(agents, buildBackendTargetKeyV2({ kind: 'agent', identity: { pluginId: 'acme.review', localId: 'reviewer' } }))).toBe(agents[1]);
        expect(findMachineAgentForBackendTarget(agents, { kind: 'backend', backendId: 'custom-acp' })).toBeNull();
        expect(findMachineAgentForBackendTarget(agents, { kind: 'backend', backendId: 'second' })).toBeNull();
        expect(findMachineAgentForBackendTarget(agents, { ...target, definitionId: 'missing' })).toBeNull();
        expect(findMachineAgentForBackendTargetKey(agents, buildBackendTargetKeyV2({ ...target, definitionId: 'missing' }))).toBeNull();
    });
});
