import { expect, test, vi } from 'vitest';
import type { AgentContribution } from '../agents.js';

const registration = vi.hoisted(() => ({ cases: new Map<string, () => void>() }));
// The third-party runner is the boundary; execute the real kit's registered assertions.
vi.mock('vitest', async importOriginal => ({
    ...await importOriginal<typeof import('vitest')>(),
    describe: (_title: string, register: () => void) => register(),
    it: (title: string, run: () => void) => registration.cases.set(title, run),
    beforeEach: () => {},
    afterEach: () => {},
}));

import { runAgentSkillDeliveryContract } from './skillDeliveryContract.js';

test.each(['native_mcp', 'native_extension', 'unsupported'] as const)('checks the %s no-delivery declaration without opening a vendor session', delivery => {
    registration.cases.clear();
    const agent = {
        id: 'no-delivery-fixture', title: 'No delivery fixture', primary: 'sessions', runtime: { kind: 'custom' },
        capabilities: {
            sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
            skills: { delivery: 'none', nativeDisable: 'unsupported', liveReload: 'unsupported' },
            ...(delivery === 'unsupported' ? {} : { tools: { delivery } }),
        },
    } satisfies AgentContribution;
    runAgentSkillDeliveryContract({ agent });
    const check = [...registration.cases].find(([title]) => title.startsWith('K0'))?.[1];
    expect(check, 'the public kit must register the declaration outcome contract').toBeTypeOf('function');
    expect(() => check!()).not.toThrow();
    expect(registration.cases.size).toBe(1);
});

test('rejects an undeclared native carrier on an index Agent', () => {
    registration.cases.clear();
    runAgentSkillDeliveryContract({ agent: {
        id: 'invalid-index-fixture', title: 'Invalid index fixture', primary: 'sessions',
        runtime: { kind: 'acp', transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'fixture' } },
            definition: { skills: { sessionDelivery: { kind: 'env_path_list', envKey: 'FIXTURE_SKILLS', separator: ',', value: 'skills_root' } } } },
        capabilities: {
            sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
            skills: { delivery: 'none', nativeDisable: 'unsupported', liveReload: 'unsupported' },
            tools: { delivery: 'native_mcp' },
        },
    } });
    const check = [...registration.cases.values()][0];
    expect(check).toBeTypeOf('function');
    expect(() => check!()).toThrow('K0: a no-delivery declaration must not configure a native skill carrier');
});

test('requires real launch adapters for native delivery', () => {
    expect(() => runAgentSkillDeliveryContract({ agent: {
        id: 'native-fixture', title: 'Native fixture', primary: 'sessions', runtime: { kind: 'custom' },
        capabilities: {
            sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
            skills: { delivery: 'session_dir', nativeDisable: 'unsupported', liveReload: 'unsupported' },
        },
    } })).toThrow('Native skill delivery requires launch contract adapters');
});
