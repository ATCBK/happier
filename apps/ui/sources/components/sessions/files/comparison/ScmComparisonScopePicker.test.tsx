import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { HappierInputPickerProvider } from '@happier-dev/plugin-ui/presentation';
import { ScmComparisonSourceProtocolSchema } from '@happier-dev/protocol/scm/comparison';
import { renderScreen } from '@/dev/testkit';
import { createInputTypePickerPort } from '@/components/sessions/actions/inputTypePickerPort';
import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { filesComparisonScopeOptionKey, type FilesComparisonScopeOption } from './filesComparison';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: key => key });
});

const comparison = { kind: 'pullRequest' as const, locator: { providerId: 'example-forge', repository: 'example/repository', number: 17,
    sourceAction: { action: { pluginId: 'happier.example.source', localId: 'read-comparison' }, input: { number: 17 } } } };

async function mount(settlement: unknown, available = true) {
    const { ScmComparisonScopePicker } = await import('./ScmComparisonScopePicker');
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    const identity = { pluginId: 'happier.triage', localId: 'pull-request-comparison' };
    const port = createInputTypePickerPort({ resolveType: () => available ? {
        identity, occurrenceId: 'triage-current', definition: { id: identity.localId, title: 'Pull request', semantic: 'scmPullRequestComparison',
            valueSchema: ScmComparisonSourceProtocolSchema.jsonSchema, picker: 'comparison-picker' },
    } : null, canOpenPicker: () => available, openPicker: async () => settlement });
    let mounts = 0;
    function ProjectComparison() {
        React.useEffect(() => { mounts++; }, []);
        const [current, setCurrent] = React.useState<SessionScmReviewComparison>({ kind: 'workingTree' });
        return <ScmComparisonScopePicker options={[{ comparison: null, sourceKind: 'pullRequest', group: 'explainOnly',
            label: 'Pull request', subtitle: 'Select source evidence', fileCount: null }]} current={current} currentLabel={current.kind}
            fileCount={null} onSelect={setCurrent} />;
    }
    const screen = await renderScreen(<HappierInputPickerProvider port={port}><ProjectComparison /></HappierInputPickerProvider>);
    const menu = () => screen.findByType(DropdownMenu);
    return { menu, screen, mounts: () => mounts };
}

describe('comparison picker return', () => {
    it('keeps identical Session selectors qualified by their admitted evidence Session', async () => {
        const { ScmComparisonScopePicker } = await import('./ScmComparisonScopePicker');
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const onSelect = vi.fn();
        const options: FilesComparisonScopeOption[] = ['session-a', 'session-b'].map(evidenceSessionId => ({
            comparison: { kind: 'session' }, evidenceSessionId, sourceKind: 'session', group: 'explainOnly',
            label: evidenceSessionId, subtitle: 'Session evidence', fileCount: null,
        }));
        const screen = await renderScreen(<ScmComparisonScopePicker options={options} current={{ kind: 'session' }}
            currentEvidenceSessionId="session-a" currentLabel="Session A" fileCount={null} onSelect={onSelect} />);
        const menu = screen.findByType(DropdownMenu);
        expect(menu.props.items.map((item: { checked: boolean }) => item.checked)).toEqual([true, false]);
        expect(menu.props.items[0].id).not.toBe(menu.props.items[1].id);
        await act(async () => { menu.props.onSelect(filesComparisonScopeOptionKey(options[1])); });
        expect(onSelect).toHaveBeenCalledWith({ kind: 'session' }, 'session-b');
        await screen.unmount();
    });
    it('applies admitted PR evidence to the same mounted Project comparison', async () => {
        const { menu, screen, mounts } = await mount({ kind: 'completed', input: comparison });
        await act(async () => { menu().props.onSelect('pullRequest'); });
        expect(menu().props.selectedId).toBe(JSON.stringify(['pullRequest', comparison.locator]));
        expect(mounts()).toBe(1);
        await screen.unmount();
    });
    it('preserves the previous comparison on cancel and does not offer an unavailable source', async () => {
        const cancelled = await mount({ kind: 'cancelled' });
        await act(async () => { cancelled.menu().props.onSelect('pullRequest'); });
        expect(cancelled.menu().props.selectedId).toBe('workingTree');
        expect(cancelled.mounts()).toBe(1);
        await cancelled.screen.unmount();
        const unavailable = await mount({ kind: 'completed', input: comparison }, false);
        expect(unavailable.menu().props.items[0].disabled).toBe(true);
        await unavailable.screen.unmount();
    });
});
