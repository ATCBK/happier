import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installTimerCensus } from '@/dev/testkit/performance/timerCensus';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => params ? `${key}:${JSON.stringify(params)}` : key });
});

// Module transform is paid once, outside any single case's time budget.
beforeAll(async () => {
    await import('./WorkflowSaveStatus');
}, 300_000);

afterEach(async () => {
    await standardCleanup();
});

const draft = {
    draftId: 'local-draft',
    name: 'Review',
    version: 1 as const,
    defaults: {},
    inputs: [],
    blocks: [{
        kind: 'step' as const,
        id: 'review',
        document: { text: 'Review local changes', references: [], attachments: [] },
        input: [],
        result: { kind: 'text' as const },
    }],
};

describe('WorkflowSaveStatus', () => {
    it('installs no saved-age clock while its retained editor is hidden, then resumes current age on presentation', async () => {
        const { WorkflowSaveStatus } = await import('./WorkflowSaveStatus');
        vi.useFakeTimers();
        const now = Date.UTC(2026, 9, 23, 12);
        vi.setSystemTime(now);
        const census = installTimerCensus(stack => stack.includes('WorkflowSaveStatus.tsx') ? 'save-age' : null);
        const content = <WorkflowSaveStatus state={{ kind: 'saved', savedAtMs: now - 120_000 }} localDraft={draft}
            onSave={() => {}} onSaveAsCopy={() => {}} testIDPrefix="clock" />;
        const screen = await renderScreen(<PluginSurfaceFocusEligibilityProvider active={false}>{content}</PluginSurfaceFocusEligibilityProvider>);
        try {
            expect(census.read().filter(timer => timer.consumer === 'save-age')).toEqual([]);
            expect(vi.getTimerCount()).toBe(0);
            await act(async () => { vi.advanceTimersByTime(60_000); });
            // A visible second pane still ages even when it does not own keyboard focus.
            await screen.update(<PluginSurfaceFocusEligibilityProvider active={false} presentationActive>{content}</PluginSurfaceFocusEligibilityProvider>);
            expect(census.read().filter(timer => timer.consumer === 'save-age')).toEqual([
                { kind: 'interval', delayMs: 60_000, consumer: 'save-age' },
            ]);
            expect(screen.getTextContent()).toContain('workflows.page.saveStatus.savedAge');
            expect(screen.getTextContent()).toContain(JSON.stringify({ age: formatRelativeTimeShort(now - 120_000, now + 60_000) }));
            await act(async () => { vi.advanceTimersByTime(60_000); });
            await screen.update(<PluginSurfaceFocusEligibilityProvider active={false}>{content}</PluginSurfaceFocusEligibilityProvider>);
            expect(census.read().filter(timer => timer.consumer === 'save-age')).toEqual([]);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            await screen.unmount();
            census.stop();
            vi.useRealTimers();
        }
    });

    it('is its own receipt: one element reads Unsaved changes with Save, then Saving…, then Saved just now', async () => {
        const { WorkflowSaveStatus } = await import('./WorkflowSaveStatus');
        const onSave = vi.fn();
        const now = Date.UTC(2026, 8, 30, 12, 0, 0);
        type State = React.ComponentProps<typeof WorkflowSaveStatus>['state'];
        let setState: (state: State) => void = () => {};
        function Harness() {
            const [state, set] = React.useState<State>({ kind: 'unsaved' });
            setState = set;
            return React.createElement(WorkflowSaveStatus, {
                state,
                localDraft: draft,
                onSave,
                onSaveAsCopy: vi.fn(),
                nowMs: now,
                testIDPrefix: 'workflow-editor',
            });
        }
        const screen = await renderScreen(React.createElement(Harness));
        const update = async (state: State) => { await act(async () => { setState(state); }); };

        const status = () => screen.findByTestId('workflow-editor-save-status');
        expect(status()).not.toBeNull();
        expect(screen.getTextContent()).toContain('workflows.page.saveStatus.unsaved');
        await screen.pressByTestIdAsync('workflow-editor-save');
        expect(onSave).toHaveBeenCalledTimes(1);

        await update({ kind: 'saving' });
        expect(status()).not.toBeNull();
        expect(screen.getTextContent()).toContain('workflows.page.saveStatus.saving');
        // While saving, Save is not repeatable.
        expect(screen.findByTestId('workflow-editor-save')).toBeNull();

        await update({ kind: 'saved', savedAtMs: now - 10_000 });
        expect(screen.getTextContent()).toContain('workflows.page.saveStatus.savedJustNow');
        // No raw revision ("h1 · b2") is ever the receipt.
        expect(screen.getTextContent()).not.toMatch(/h\d+ · b\d+/);

        await update({ kind: 'saved', savedAtMs: now - 3 * 60_000 });
        expect(screen.getTextContent()).toContain('workflows.page.saveStatus.savedAge');
    });

    it('reads Not saved yet for a pristine draft, with no Save and no validation text', async () => {
        const { WorkflowSaveStatus } = await import('./WorkflowSaveStatus');
        const screen = await renderScreen(React.createElement(WorkflowSaveStatus, {
            state: { kind: 'notSaved' },
            localDraft: draft,
            onSave: vi.fn(),
            onSaveAsCopy: vi.fn(),
            testIDPrefix: 'workflow-editor',
        }));
        expect(screen.getTextContent()).toBe('workflows.page.saveStatus.notSaved');
        expect(screen.findByTestId('workflow-editor-save')).toBeNull();
    });

    it('keeps edits after a failed save and offers Try again through the same Save', async () => {
        const { WorkflowSaveStatus } = await import('./WorkflowSaveStatus');
        const onSave = vi.fn();
        const screen = await renderScreen(React.createElement(WorkflowSaveStatus, {
            state: { kind: 'failed', reason: 'The server did not answer.' },
            localDraft: draft,
            onSave,
            onSaveAsCopy: vi.fn(),
            testIDPrefix: 'workflow-editor',
        }));
        expect(screen.getTextContent()).toContain('workflows.page.saveStatus.failed');
        await screen.pressByTestIdAsync('workflow-editor-save-retry');
        expect(onSave).toHaveBeenCalledTimes(1);
    });

    it('retains the local document in a conflict and offers comparison plus save-as-copy recovery', async () => {
        const { WorkflowSaveStatus } = await import('./WorkflowSaveStatus');
        const saveAsCopy = vi.fn();
        const currentDraft = { ...draft, draftId: 'current-draft', blocks: [{ ...draft.blocks[0], document: { ...draft.blocks[0].document, text: 'Review remote changes' } }] };
        const screen = await renderScreen(React.createElement(WorkflowSaveStatus, {
            state: { kind: 'conflict', conflict: { currentDraft, currentRevision: { headerVersion: 3, bodyVersion: 3 } } },
            localDraft: draft,
            onSave: vi.fn(),
            onSaveAsCopy: saveAsCopy,
            testIDPrefix: 'workflow-editor',
        }));

        expect(screen.getTextContent()).toContain('workflows.save.conflictTitle');
        expect(screen.getTextContent()).toContain('workflows.save.conflictBody');
        await screen.pressByTestIdAsync('workflow-editor-compare');
        expect(screen.getTextContent()).toContain('Review local changes');
        expect(screen.getTextContent()).toContain('Review remote changes');
        await screen.pressByTestIdAsync('workflow-editor-save-as-copy');
        expect(saveAsCopy).toHaveBeenCalledTimes(1);
    });

    it('omits Compare when the current Artifact cannot be read while keeping save-as-copy available', async () => {
        const { WorkflowSaveStatus } = await import('./WorkflowSaveStatus');
        const screen = await renderScreen(React.createElement(WorkflowSaveStatus, {
            state: { kind: 'conflict', conflict: { currentDraft: null, currentRevision: null } },
            localDraft: draft,
            onSave: vi.fn(),
            onSaveAsCopy: vi.fn(),
            testIDPrefix: 'workflow-editor',
        }));

        expect(screen.findByTestId('workflow-editor-compare')).toBeNull();
        expect(screen.findByTestId('workflow-editor-save-as-copy')).not.toBeNull();
    });
});
