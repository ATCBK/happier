import { describe, expect, it } from 'vitest';

import {
    createExecutionRunDetailsTab,
    createDiscussionSelectionInteractiveExecutionRunDraftDetailsTab,
    resolveExecutionRunLaunchTitle,
    createInteractiveExecutionRunDraftDetailsTab,
    resolveExecutionRunLauncherIntent,
} from './executionRunLauncherModel';

describe('execution Run conversation details resources', () => {
    it('keeps an unmaterialized conversation distinct from a bounded launcher and replaces it with the exact Run resource', () => {
        expect(createInteractiveExecutionRunDraftDetailsTab()).toMatchObject({
            key: 'execution-run-conversation-draft',
            resource: { kind: 'executionRunLauncher', mode: 'conversation' },
        });
        expect(createExecutionRunDetailsTab('run_1')).toMatchObject({
            key: 'execution-run:run_1',
            resource: { kind: 'executionRun', runId: 'run_1' },
        });
        expect(createExecutionRunDetailsTab('run_1', { retryInputLocalId: 'first-input-1' })).toMatchObject({
            key: 'execution-run:run_1',
            resource: {
                kind: 'executionRun',
                runId: 'run_1',
                retryInputLocalId: 'first-input-1',
            },
        });
    });

    it('keeps Discussion selection provenance and prefill on the same conversation draft resource', () => {
        const source = {
            kind: 'discussion' as const,
            serverId: 'server-a',
            discussionId: 'discussion_1',
            messageIds: ['message_1'],
            draftCorrelationId: 'draft_1',
        };
        expect(createDiscussionSelectionInteractiveExecutionRunDraftDetailsTab({ source, initialText: 'Investigate this' })).toMatchObject({
            key: 'execution-run-conversation-draft:discussion:draft_1',
            resource: { kind: 'executionRunLauncher', mode: 'conversation', source, initialInstructions: 'Investigate this' },
        });
    });
});

describe('execution Run tab titles', () => {
    it('never titles a Run tab by its id', () => {
        const tab = createExecutionRunDetailsTab('7f3a91c2');
        expect(tab.title).not.toContain('7f3a91c2');
        expect(tab.title.trim().length).toBeGreaterThan(0);
        expect(createExecutionRunDetailsTab('7f3a91c2', undefined, 'Review #2481 changes').title).toBe('Review #2481 changes');
    });

    it('titles a launched Run by what was asked, else by its intent', () => {
        expect(resolveExecutionRunLaunchTitle({ intent: 'review', instructions: '\n  Focus on state loss on resize.\nAnd the sheet.' }))
            .toBe('Focus on state loss on resize.');
        const reviewTitle = resolveExecutionRunLaunchTitle({ intent: 'review', instructions: '   ' });
        const planTitle = resolveExecutionRunLaunchTitle({ intent: 'plan', instructions: null });
        expect(reviewTitle.trim().length).toBeGreaterThan(0);
        expect(planTitle.trim().length).toBeGreaterThan(0);
        expect(reviewTitle).not.toBe(planTitle);
    });
});

describe('resolveExecutionRunLauncherIntent', () => {
    it('keeps supported launcher intents and rejects valid but unsupported execution-run intents', () => {
        expect(resolveExecutionRunLauncherIntent('review')).toBe('review');
        expect(resolveExecutionRunLauncherIntent('plan')).toBe('plan');
        expect(resolveExecutionRunLauncherIntent('delegate')).toBe('delegate');
        expect(resolveExecutionRunLauncherIntent('voice_agent')).toBeNull();
        expect(resolveExecutionRunLauncherIntent('memory_hints')).toBeNull();
    });

    it('rejects unknown intents instead of rewriting them', () => {
        expect(resolveExecutionRunLauncherIntent('bogus')).toBeNull();
        expect(resolveExecutionRunLauncherIntent({ intent: 'delegate' })).toBeNull();
    });
});
