import { describe, expect, it } from 'vitest';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import type { OpenedSessionFollowRuleV1 } from '@happier-dev/protocol/sessions/follow/actions';

import {
    buildMakeCoordinatorDraft,
    buildMakeCoordinatorEnableInput,
    describeMakeCoordinatorOverlap,
} from './makeCoordinatorModel';

const SERVER = 'home-1';
const PROJECT = { serverId: SERVER, projectKey: 'payments' };
const SETTINGS = {
    coordinationCoordinatorRoleId: 'orchestrator',
    coordinationCoordinatorKeep: 'suggest' as const,
    coordinationCoordinatorAnswersWorkerQuestions: true,
    coordinationCoordinatorSuggestProjectRule: true,
    coordinationCoordinatorSuggestHomeRule: true,
};

const CHECKOUT = { id: 'checkout', projectKey: PROJECT.projectKey, serverId: SERVER,
    machineId: 'machine', rootPath: '/work/payments', label: null, createdAtMs: 1, lastOpenedAtMs: null };

function homeWideRule(
    ruleId: string,
    receiverSessionId: string,
): OpenedSessionFollowRuleV1 {
    return {
        ruleId,
        version: 3,
        receiver: { kind: 'session', sessionId: receiverSessionId },
        definition: {
            v: 1,
            enabled: true,
            policy: { preset: 'important' },
            filter: normalizeSessionListFilterV1({
                show: 'sessions',
                startedBy: ['you'],
                scope: 'all_accessible',
                homeServerIds: [SERVER],
            }),
        },
    } as OpenedSessionFollowRuleV1;
}

describe('Make coordinator draft', () => {
    it('starts with the project rule on, the Home rule off, and keeps where the setting resolves for a project', () => {
        const draft = buildMakeCoordinatorDraft({
            serverId: SERVER,
            sessionId: 's-new',
            ownerMetadata: { projectId: PROJECT.projectKey },
            settings: SETTINGS,
            ruleIds: { project: 'r-project', home: 'r-home' },
            ruleCensus: null,
        });
        expect(draft.rules.map((rule) => [rule.scope, rule.enabled])).toEqual([
            ['project', true],
            ['home', false],
        ]);
        expect(draft.keep).toBe('list_pin');
        expect(draft.keepFromSetting).toBe(true);
    });

    it('a session without a project starts Home-wide and resolves the left rail', () => {
        const draft = buildMakeCoordinatorDraft({
            serverId: SERVER,
            sessionId: 's-new',
            ownerMetadata: null,
            settings: SETTINGS,
            ruleIds: { project: 'r-project', home: 'r-home' },
            ruleCensus: null,
        });
        expect(draft.rules.map((rule) => [rule.scope, rule.enabled])).toEqual([
            ['home', true],
        ]);
        expect(draft.keep).toBe('rail_bot');
    });

    it('pre-selects Managed by only when exactly one other session follows Home-wide', () => {
        const one = buildMakeCoordinatorDraft({
            serverId: SERVER,
            sessionId: 's-new',
            ownerMetadata: { projectId: PROJECT.projectKey },
            settings: SETTINGS,
            ruleIds: { project: 'r-project', home: 'r-home' },
            ruleCensus: {
                serverId: SERVER,
                coverage: 'complete',
                rules: [homeWideRule('r-daily', 's-daily')],
            },
        });
        expect(one.managedBySessionId).toBe('s-daily');
        const two = buildMakeCoordinatorDraft({
            serverId: SERVER,
            sessionId: 's-new',
            ownerMetadata: { projectId: PROJECT.projectKey },
            settings: SETTINGS,
            ruleIds: { project: 'r-project', home: 'r-home' },
            ruleCensus: {
                serverId: SERVER,
                coverage: 'complete',
                rules: [
                    homeWideRule('r-daily', 's-daily'),
                    homeWideRule('r-rel', 's-release'),
                ],
            },
        });
        expect(two.managedBySessionId).toBeNull();
    });

    it('offers the accepted Project for path-only membership, and withholds ambiguous or unreadable membership', () => {
        const input = { serverId: SERVER, sessionId: 'path-only',
            ownerMetadata: { machineId: CHECKOUT.machineId, path: CHECKOUT.rootPath }, workspaceRefs: [CHECKOUT],
            settings: SETTINGS, ruleIds: { project: 'project-rule', home: 'home-rule' }, ruleCensus: null };
        const draft = buildMakeCoordinatorDraft(input);
        expect(draft.rules[0]).toMatchObject({ scope: 'project', enabled: true,
            suggestion: { ruleDefinition: { filter: { projects: { include: [PROJECT] } } } } });
        expect(draft.project).toEqual(PROJECT);
        expect(buildMakeCoordinatorDraft({ ...input, workspaceRefs: undefined }).project).toBeNull();
        expect(buildMakeCoordinatorDraft({ ...input, ownerMetadata: null }).project).toBeNull();
        expect(buildMakeCoordinatorDraft({ ...input, workspaceRefs: [CHECKOUT, { ...CHECKOUT, id: 'other', projectKey: 'other' }] }).project).toBeNull();
    });
});

describe('Make coordinator enable input', () => {
    it('sends only the rules left on, the chosen place, and Managed by only when it changes the current manager', () => {
        const draft = buildMakeCoordinatorDraft({
            serverId: SERVER,
            sessionId: 's-new',
            ownerMetadata: { projectId: PROJECT.projectKey },
            settings: SETTINGS,
            ruleIds: { project: 'r-project', home: 'r-home' },
            ruleCensus: {
                serverId: SERVER,
                coverage: 'complete',
                rules: [homeWideRule('r-daily', 's-daily')],
            },
        });
        const input = buildMakeCoordinatorEnableInput(
            { ...draft, keep: 'none' },
            { currentManagerSessionId: null },
        );
        expect(input.keep).toBe('none');
        expect(input.ruleSuggestions.map((rule) => rule.source.ruleId)).toEqual([
            'r-project',
        ]);
        expect(input.managedBy).toEqual({
            managerSessionId: 's-daily',
            expectedManagerSessionId: null,
        });
        expect(input.answersWorkerQuestions).toBe(true);

        const unchanged = buildMakeCoordinatorEnableInput(draft, {
            currentManagerSessionId: 's-daily',
        });
        expect(unchanged.managedBy).toBeUndefined();
    });
});

describe('Make coordinator overlap', () => {
    it('names the other session receivers whose rules already match, never this session', () => {
        const census = {
            serverId: SERVER,
            coverage: 'complete' as const,
            rules: [
                homeWideRule('r-daily', 's-daily'),
                homeWideRule('r-self', 's-new'),
            ],
        };
        const match = (sessionId: string) => ({
            serverId: SERVER,
            source: { kind: 'session' as const, sessionId },
        });
        const overlap = describeMakeCoordinatorOverlap({
            sessionId: 's-new',
            census,
            overlaps: [
                { ruleId: 'r-daily', matches: [match('a'), match('b'), match('c')] },
                { ruleId: 'r-self', matches: [match('a')] },
                { ruleId: 'r-unknown', matches: [match('a')] },
            ],
        });
        expect(overlap).toEqual([
            { rule: census.rules[0], receiverSessionId: 's-daily', count: 3 },
        ]);
    });
});
