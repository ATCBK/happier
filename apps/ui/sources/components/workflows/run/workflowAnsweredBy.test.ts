import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string, params?: Record<string, unknown>) =>
        (params ? `${key}:${JSON.stringify(params)}` : key) });
});

import { resolveAnsweredByLabel } from './workflowAnsweredBy';

const NAMED = { name: 'Ada Chen', firstName: null, lastName: null, username: null, avatarUrl: null } as const;
const UNNAMED = { name: null, firstName: null, lastName: null, username: null, avatarUrl: null } as const;
const human = { kind: 'human', accountId: 'acct-ada' } as const;

describe('resolveAnsweredByLabel', () => {
    it('names the viewer as "you" and a known person by their Account name', () => {
        expect(resolveAnsweredByLabel({ resultSource: human, viewerAccountId: 'acct-ada', profile: NAMED }))
            .toBe('workflows.run.answeredByYou');
        expect(resolveAnsweredByLabel({ resultSource: human, viewerAccountId: 'acct-bo', profile: NAMED }))
            .toBe('workflows.run.answeredBy:{"name":"Ada Chen"}');
    });

    it('falls back to an anonymous person instead of guessing when no authorized profile is held', () => {
        expect(resolveAnsweredByLabel({ resultSource: human, viewerAccountId: 'acct-bo', profile: null }))
            .toBe('workflows.run.answeredByPerson');
        expect(resolveAnsweredByLabel({ resultSource: human, viewerAccountId: 'acct-bo', profile: UNNAMED }))
            .toBe('workflows.run.answeredByPerson');
    });

    it('says nothing for results that no person answered', () => {
        expect(resolveAnsweredByLabel({ resultSource: { kind: 'execution_input' }, viewerAccountId: 'acct-bo', profile: NAMED })).toBeNull();
        expect(resolveAnsweredByLabel({ resultSource: { kind: 'published', by: 'agent' }, viewerAccountId: 'acct-bo', profile: NAMED })).toBeNull();
        expect(resolveAnsweredByLabel({ resultSource: undefined, viewerAccountId: 'acct-bo', profile: NAMED })).toBeNull();
    });
});
