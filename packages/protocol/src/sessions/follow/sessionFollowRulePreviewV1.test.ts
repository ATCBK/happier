import { describe, expect, it } from 'vitest';
import { normalizeSessionListFilterV1 } from '../listFilter/sessionListFilterV1.js';
import { evaluateFollowRulePreviewV1, excludeProjectFromSessionFollowRuleV1, FollowRulePreviewResultV1Schema, includeExcludedProjectInSessionFollowRuleV1 } from './sessionFollowRulePreviewV1.js';

describe('Follow rule preview', () => {
    it('does not enroll an attention Run that the rule starter facet excludes', () => {
        const result = evaluateFollowRulePreviewV1({ filter: normalizeSessionListFilterV1({ scope: 'all_accessible', homeServerIds: ['home'], startedBy: ['you'] }),
            coverage: 'complete', candidates: [{ source: { kind: 'workflow_run', runId: 'trigger' },
                facts: { serverId: 'home', kind: 'run', startedBy: 'triggers', attentionRequired: true } }] });
        expect(result).toMatchObject({ coverage: 'complete', matches: [], matchCount: 0 });
    });
    it('uses canonical unavailable exclusions, qualified sources and truthful corpus coverage for matches and overlaps', () => {
        const filter = normalizeSessionListFilterV1({ startedBy: ['you', 'agents', 'triggers'], scope: 'all_accessible', homeServerIds: ['home'],
            projects: { include: [], exclude: [{ serverId: 'home', projectKey: 'other' }] } });
        const candidates = ['payments', null, 'other'].map((projectId, index) => ({ source: { kind: 'session' as const, sessionId: `s${index}` },
            facts: { serverId: 'home', kind: 'session' as const, projectMetadata: projectId === null ? null : { projectId } } }));
        const preview = evaluateFollowRulePreviewV1({ filter, candidates, coverage: 'complete', otherRules: [{ ruleId: 'daily', enabled: true, filter }] });
        expect(FollowRulePreviewResultV1Schema.parse(preview)).toEqual({ coverage: 'partial', matchCount: 1,
            matches: [{ serverId: 'home', source: { kind: 'session', sessionId: 's0' } }],
            unavailable: [{ serverId: 'home', source: { kind: 'session', sessionId: 's1' } }],
            overlaps: [{ ruleId: 'daily', matches: [{ serverId: 'home', source: { kind: 'session', sessionId: 's0' } }] }] });
        expect(evaluateFollowRulePreviewV1({ filter, candidates: [], coverage: 'complete' })).toMatchObject({ coverage: 'complete', matchCount: 0 });
        expect(evaluateFollowRulePreviewV1({ filter, candidates: [], coverage: 'unavailable' })).toMatchObject({ coverage: 'unavailable', matchCount: 0 });
        expect(evaluateFollowRulePreviewV1({ filter, candidates: [], coverage: 'partial', continuation: 'producer-cursor' })).toMatchObject({ coverage: 'partial', continuation: 'producer-cursor' });
    });

    it('adds one visible qualified Project exclusion without mutating the previous definition', () => {
        const definition = { v: 1 as const, enabled: true, filter: normalizeSessionListFilterV1(), policy: { preset: 'important' as const } };
        const project = { serverId: 'home', projectKey: 'payments' };
        const next = excludeProjectFromSessionFollowRuleV1(definition, project);
        expect(next.filter.projects).toEqual({ include: [], exclude: [project] });
        expect(definition.filter.projects).toBeUndefined();
        expect(excludeProjectFromSessionFollowRuleV1(next, project)).toEqual(next);
    });

    it('includes an excluded Project again, keeping the other exclusions and dropping an emptied facet', () => {
        const definition = { v: 1 as const, enabled: true, filter: normalizeSessionListFilterV1(), policy: { preset: 'important' as const } };
        const payments = { serverId: 'home', projectKey: 'payments' };
        const mobile = { serverId: 'home', projectKey: 'mobile' };
        const both = excludeProjectFromSessionFollowRuleV1(excludeProjectFromSessionFollowRuleV1(definition, payments), mobile);
        expect(includeExcludedProjectInSessionFollowRuleV1(both, payments).filter.projects).toEqual({ include: [], exclude: [mobile] });
        expect(includeExcludedProjectInSessionFollowRuleV1(excludeProjectFromSessionFollowRuleV1(definition, payments), payments)).toEqual(definition);
    });
});
