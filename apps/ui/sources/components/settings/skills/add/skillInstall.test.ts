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
    it('retains digest pins for index previews through the existing install source carrier', async () => {
        const { SKILL_ACTION_INPUT_SCHEMAS_V1 } = await import('@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1');
        const source = { kind: 'link' as const, url: 'https://skills.example.test/.well-known/skills/index.json' };
        const provenance = { kind: 'wellKnown' as const, indexUrl: source.url, name: 'code-review',
            digest: `sha256:${'a'.repeat(64)}`, publishedDigest: `sha256:${'b'.repeat(64)}` };
        const item = { path: 'code-review', name: 'code-review', description: null, files: [], trust: 'text_only',
            cost: { descriptionTokens: 0, bodyTokens: 1 }, provenance };
        const { execute, calls } = home((_actionId, input) => (input as { dryRun?: boolean }).dryRun
            ? { ok: true, result: { items: [item] } } : { ok: true, result: { skillIds: ['review'], includedInSessionId: null } });
        const preview = await previewSkillInstall(execute, source);
        if (!preview.ok) throw new Error(preview.error);
        await installSkills(execute, { source: preview.source });
        expect(SKILL_ACTION_INPUT_SCHEMAS_V1['skills.install'].parse(calls[1]!.input).source)
            .toEqual({ ...source, refs: [provenance] });
    });

    it('retains every reviewed repository pin from a multi-origin link through the install schema', async () => {
        const { SkillInstallPreviewV1Schema, SKILL_ACTION_INPUT_SCHEMAS_V1 } = await import('@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1');
        const source = { kind: 'link' as const, url: 'https://example.test/marketplace.json' };
        const items = ['first', 'second'].map((name, index) => SkillInstallPreviewV1Schema.parse({
            path: `skills/${name}`, name, description: null, files: [], trust: 'text_only', cost: { descriptionTokens: 0, bodyTokens: 1 },
            provenance: { kind: 'link', url: source.url, ref: { kind: 'gitTree', repo: `https://github.com/fixture/${name}`,
                path: `skills/${name}`, commit: String(index + 1).repeat(40), treeSha: 'a'.repeat(40) } },
        }));
        const { execute, calls } = home((_actionId, input) => (input as { dryRun?: boolean }).dryRun
            ? { ok: true, result: { items } } : { ok: true, result: { skillIds: ['first', 'second'], includedInSessionId: null } });
        const preview = await previewSkillInstall(execute, source);
        if (!preview.ok) throw new Error(preview.error);
        await installSkills(execute, { source: preview.source });
        const consumed = SKILL_ACTION_INPUT_SCHEMAS_V1['skills.install'].parse(calls[1]!.input);
        expect(consumed.source).toEqual({ ...source, refs: items.map(item => item.provenance.kind === 'link' ? item.provenance.ref : null) });
    });

    it('reports an unusable link preview instead of falling back to an unpinned Add', async () => {
        const { execute } = home(() => ({ ok: true, result: { items: [{ path: '', name: 'sample', description: null, files: [],
            trust: 'text_only', cost: { descriptionTokens: 0, bodyTokens: 1 }, provenance: { kind: 'upload', importedAt: 1 } }] } }));
        expect(await previewSkillInstall(execute, { kind: 'link', url: 'https://example.test/skills.git' }))
            .toEqual({ ok: false, error: 'skill_preview_pin_missing' });
    });

    it('keeps the registry owner\'s typed failure so the link can say "try again at" instead of a generic error', async () => {
        const { execute } = home(() => ({ ok: false, errorCode: 'rate_limited', error: 'rate_limited',
            details: { registryStatus: { state: 'rate_limited', retryAt: 1_791_938_301_000 } } }));
        await expect(previewSkillInstall(execute, { kind: 'link', url: 'https://github.com/anthropics/skills' })).resolves.toEqual({
            ok: false, error: 'rate_limited', status: { state: 'rate_limited', retryAt: 1_791_938_301_000 } });
    });
});
