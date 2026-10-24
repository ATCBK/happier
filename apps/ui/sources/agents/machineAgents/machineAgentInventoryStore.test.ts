import { describe, expect, it, vi } from 'vitest';
import type { MachineAgentInventoryItem } from '@happier-dev/protocol/capabilities';
import { createMachineAgentInventoryStore } from './machineAgentInventoryStore';
import { resolveMachineAgentStatus } from '@/components/machines/agents/machineAgentPresentation';
import { isMachineAgentReady } from './resolveMachineAgentState';

const facts = (agentId: string): MachineAgentInventoryItem => ({ agentId, title: agentId, installed: true,
    version: '1.0.0', latestVersion: '1.0.0', update: { supported: true, command: null },
    signIn: { status: 'signedIn', loginSupport: 'login_terminal' }, platform: { supported: true },
    install: { available: true, mode: 'managed', sizeBytes: null, guideUrl: null }, dependencies: [] });

describe('machine agent inventory store', () => {
    it('projects held installed counts and all reported versions without notifying for unrelated arrivals', () => {
        const store = createMachineAgentInventoryStore();
        const keys = Array.from({ length: 139 }, (_, i) => `account-a/machine-${i}`);
        for (const key of keys) store.publish(key, { status: 'ready', items: [facts('claude'), facts('codex')], lastCheckedAt: 1 });
        const summary = store.createHeldAgentSummary(keys, 'claude');
        expect(summary.getSnapshot()).toEqual({ machineCount: 139, versions: ['1.0.0'], unknownVersionCount: 0, complete: true });
        const initial = summary.getSnapshot();
        const changed = vi.fn();
        const off = summary.subscribe(changed);
        for (const key of keys) store.publish(key, { status: 'offline', items: [], lastCheckedAt: 2 });
        store.publish(keys[0]!, { status: 'ready', items: [facts('claude'), { ...facts('codex'), version: '9' }], lastCheckedAt: 3 });
        store.publish('account-b/machine-0', { status: 'ready', items: [{ ...facts('claude'), version: 'wrong-account' }], lastCheckedAt: 3 });
        expect(summary.getSnapshot()).toBe(initial);
        expect(changed).not.toHaveBeenCalled();
        store.publish(keys[0]!, { status: 'ready', items: [{ ...facts('claude'), version: '2.1.4' }], lastCheckedAt: 4 });
        expect(summary.getSnapshot()).toEqual({ machineCount: 139, versions: ['1.0.0', '2.1.4'], unknownVersionCount: 0, complete: true });
        store.publish(keys[1]!, { status: 'ready', items: [{ ...facts('claude'), version: null }], lastCheckedAt: 5 });
        expect(summary.getSnapshot()).toEqual({ machineCount: 139, versions: ['1.0.0', '2.1.4'], unknownVersionCount: 1, complete: true });
        store.publish(keys[0]!, { status: 'ready', items: [{ ...facts('claude'), installed: false, version: null }], lastCheckedAt: 6 });
        expect(summary.getSnapshot()).toEqual({ machineCount: 138, versions: ['1.0.0'], unknownVersionCount: 1, complete: true });
        off();
    });
    it('keeps two ACP definitions separate and retains the unchanged definition identity', () => {
        const store = createMachineAgentInventoryStore();
        const first = { ...facts('custom-acp'), definitionId: 'first', title: 'First' };
        const second = { ...facts('custom-acp'), definitionId: 'second', title: 'Second', version: '2.0' };
        store.publish('machine', { status: 'ready', items: [first, second], lastCheckedAt: 1 });
        const initial = store.read('machine').agents;
        expect(Reflect.set(initial[0], 'definitionId', 'second')).toBe(false);
        expect(Reflect.set(initial, '0', initial[1])).toBe(false);
        expect(initial.map(agent => [agent.definitionId, agent.version])).toEqual([['first', '1.0.0'], ['second', '2.0']]);
        store.publish('machine', { status: 'ready', items: [first, { ...second, version: '3.0' }], lastCheckedAt: 2 });
        expect(store.read('machine').agents[0]).toBe(initial[0]);
        expect(store.read('machine').agents[1].version).toBe('3.0');
    });
    it('distinguishes failed checks from offline presence without admitting retained facts', () => {
        const store = createMachineAgentInventoryStore();
        const ready = { status: 'ready' as const, items: [facts('claude')], lastCheckedAt: 1 };
        store.publish('machine', ready);
        store.publish('machine', { status: 'error', items: [], lastCheckedAt: null });
        const failed = store.read('machine').agents[0];
        expect(failed.installed).toBe(true);
        expect(resolveMachineAgentStatus(failed)).toEqual({ kind: 'unknown', tone: 'quiet' });
        expect(isMachineAgentReady(failed)).toBe(false);

        store.publish('machine', { status: 'offline', items: [], lastCheckedAt: null });
        expect(resolveMachineAgentStatus(store.read('machine').agents[0])).toEqual({ kind: 'offline', tone: 'quiet', lastKnown: 'signedIn' });

        store.publish('machine', { status: 'ready', items: [], unavailable: [{ agentId: 'claude', reason: 'probe_failed' }], lastCheckedAt: 2 });
        expect(resolveMachineAgentStatus(store.read('machine').agents[0])).toEqual({ kind: 'unknown', tone: 'quiet' });
        expect(isMachineAgentReady(store.read('machine').agents[0])).toBe(false);

        store.publish('machine', { status: 'offline', items: [], lastCheckedAt: null });
        expect(resolveMachineAgentStatus(store.read('machine').agents[0]).kind).toBe('offline');
        store.publish('machine', ready);
        expect(resolveMachineAgentStatus(store.read('machine').agents[0]).kind).toBe('ready');
        expect(isMachineAgentReady(store.read('machine').agents[0])).toBe(true);
    });

    it('retains offline facts and identities, suppresses no-op notifications, and isolates machine/account scopes', () => {
        const store = createMachineAgentInventoryStore();
        const listener = vi.fn();
        store.subscribe('account-a/machine', listener);
        const observation = { status: 'ready' as const, items: [facts('claude'), facts('codex')], lastCheckedAt: 1 };
        store.publish('account-a/machine', observation);
        const first = store.read('account-a/machine');
        const claudeListener = vi.fn();
        store.subscribeAgent('account-a/machine', 'claude', claudeListener);
        expect(first.agents.map((agent) => agent.state)).toEqual(['ready', 'ready']);
        store.publish('account-a/machine', observation);
        expect(store.read('account-a/machine')).toBe(first);
        expect(listener).toHaveBeenCalledTimes(1);
        store.publish('account-a/machine', { ...observation, items: [facts('claude'), { ...facts('codex'), latestVersion: '2.0.0' }], lastCheckedAt: 2 });
        expect(store.read('account-a/machine').agents[0]).toBe(first.agents[0]);
        expect(claudeListener).not.toHaveBeenCalled();
        store.publish('account-a/machine', { status: 'offline', items: [], lastCheckedAt: null });
        expect(store.read('account-a/machine')).toMatchObject({ status: 'offline', lastCheckedAt: 2, agents: [{ installed: true, stale: true }, { installed: true, stale: true }] });
        expect(store.read('account-b/machine').agents).toEqual([]);
        expect(claudeListener).toHaveBeenCalledTimes(1);
    });
});
