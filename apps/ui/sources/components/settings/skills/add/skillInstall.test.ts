import { describe, expect, it, vi } from 'vitest';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SkillsRulesSetOutputV1Schema } from '@happier-dev/protocol/actions/specs/capabilityRules';
import type { MountedAuthoringActionExecute } from '@/sync/ops/actions/sessionAuthoringActions';
import type { ReachRulesChangeV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';

import { installSkills, previewSkillInstall, retrySkillRules, retrySkillInstallRules } from './skillInstall';

/** The Action transport is the boundary: the Home answers `skills.install` / `skills.rules.set`. */
function home(answer: (actionId: string, input: unknown) => ActionExecuteResult) {
    const calls: { actionId: string; input: unknown }[] = [];
    const execute = vi.fn<MountedAuthoringActionExecute>(async (actionId, input) => {
        calls.push({ actionId, input });
        return answer(actionId, input);
    });
    return { execute, calls };
}

const POINTER = { kind: 'registry' as const, sourceId: 'builtin:skills-sh', itemId: 'mattpocock/skills/grill-me', version: '49dd158aa1b2c3d4e5f60718293a4b5c6d7e8f90' };
const RULES_CHANGE = { kind: 'replace', rules: [{ target: { t: 'allMachines' }, enabled: true }] } as const satisfies ReachRulesChangeV1;

describe('installSkills (Add to library)', () => {
    it('retains every acknowledged identity and incomplete step, including a session step', async () => {
        const incomplete = [{ skillId: 'sibling', step: 'rules' }, { skillId: 'primary', step: 'session_include' }];
        const { execute } = home(() => ({ ok: true, result: { skillIds: ['primary', 'sibling'], includedInSessionId: null, incomplete } }));
        expect(await installSkills(execute, { source: POINTER })).toMatchObject({ skillIds: ['primary', 'sibling'], incomplete });
    });

    it('repairs only missing rules and never drops an outstanding step from another authority', async () => {
        const { execute, calls } = home(() => ({ ok: true, result: { ok: true, revision: 2,
            items: [{ skillId: 'sibling', previous: [], rules: [] }] } }));
        expect(await retrySkillInstallRules(execute, {
            ok: true, skillIds: ['primary', 'sibling'], rulesMissing: ['sibling'],
            incomplete: [{ skillId: 'sibling', step: 'rules' }, { skillId: 'primary', step: 'session_include' }],
        })).toMatchObject({ skillIds: ['primary', 'sibling'], rulesMissing: [], incomplete: [{ skillId: 'primary', step: 'session_include' }] });
        expect(calls.map(call => call.actionId)).toEqual(['skills.rules.set']);
    });

    it('installs exactly the version the details read, and sends no Where when the pick is untouched', async () => {
        const { execute, calls } = home(() => ({ ok: true, result: { skillIds: ['sk_1'], includedInSessionId: null } }));
        await expect(installSkills(execute, { source: POINTER })).resolves.toEqual({ ok: true, skillIds: ['sk_1'], rulesMissing: [], incomplete: [] });
        expect(calls).toEqual([{ actionId: 'skills.install', input: { source: POINTER } }]);
    });

    it('carries the changed Where as the replace change', async () => {
        const { execute, calls } = home(() => ({ ok: true, result: { skillIds: ['sk_1'], includedInSessionId: null } }));
        await installSkills(execute, { source: POINTER, where: RULES_CHANGE });
        expect(calls[0]!.input).toEqual({ source: POINTER, where: RULES_CHANGE });
    });

    it('reports a skill whose rules were not written, and the retry writes only that skill’s rules', async () => {
        const { execute, calls } = home((actionId) => actionId === 'skills.install'
            ? { ok: true, result: { skillIds: ['sk_1'], includedInSessionId: null, incomplete: [{ skillId: 'sk_1', step: 'rules' }] } }
            : { ok: true, result: SkillsRulesSetOutputV1Schema.parse({ ok: true, revision: 1,
                items: [{ skillId: 'sk_1', previous: [], rules: [] }] }) });
        const outcome = await installSkills(execute, { source: POINTER });
        expect(outcome).toEqual({ ok: true, skillIds: ['sk_1'], rulesMissing: ['sk_1'], incomplete: [{ skillId: 'sk_1', step: 'rules' }] });
        await expect(retrySkillRules(execute, { skillId: 'sk_1', change: RULES_CHANGE })).resolves.toBe(true);
        expect(calls.map((call) => call.actionId)).toEqual(['skills.install', 'skills.rules.set']);
        expect(calls[1]!.input).toEqual({ items: [{ skillId: 'sk_1' }], change: RULES_CHANGE });
    });

    it('keeps rules-only retry incomplete on an inner refusal, malformed output, or missing acknowledged identity', async () => {
        for (const result of [{ ok: false, code: 'settings_conflict' }, { ok: true },
            { ok: true, revision: 1, items: [{ skillId: 'another-skill', previous: [], rules: [] }] }]) {
            const { execute } = home(() => ({ ok: true, result }));
            await expect(retrySkillRules(execute, { skillId: 'sk_1', change: RULES_CHANGE })).resolves.toBe(false);
        }
    });

    it('keeps the created identity when the install fails after the content landed', async () => {
        const { execute } = home(() => ({ ok: false, error: 'rules write failed', errorCode: 'skill_rules_write_failed',
            details: { skillIds: ['sk_2'], incomplete: [{ skillId: 'sk_2', step: 'rules' }] } }));
        await expect(installSkills(execute, { source: POINTER })).resolves.toEqual({ ok: true, skillIds: ['sk_2'], rulesMissing: ['sk_2'], incomplete: [{ skillId: 'sk_2', step: 'rules' }] });
    });
});

describe('previewSkillInstall (From a link)', () => {
    it('keeps the registry owner\'s typed failure so the link can say "try again at" instead of a generic error', async () => {
        const { execute } = home(() => ({ ok: false, errorCode: 'rate_limited', error: 'rate_limited',
            details: { registryStatus: { state: 'rate_limited', retryAt: 1_791_938_301_000 } } }));
        await expect(previewSkillInstall(execute, { kind: 'link', url: 'https://github.com/anthropics/skills' })).resolves.toEqual({
            ok: false, error: 'rate_limited', status: { state: 'rate_limited', retryAt: 1_791_938_301_000 } });
    });
});
