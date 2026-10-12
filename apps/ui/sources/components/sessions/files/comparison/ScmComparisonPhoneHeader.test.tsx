import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

describe('ScmComparisonPhoneHeader', () => {
    it('offers one menu: each action once, the view and display choices as sections, no loose action row', async () => {
        const { ScmComparisonPhoneHeader } = await import('./ScmComparisonPhoneHeader');
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const onFind = vi.fn(); const onPropose = vi.fn(); const onDisplay = vi.fn();
        const screen = await renderScreen(<ScmComparisonPhoneHeader view="files" views={['files', 'walkthrough']}
            scope={{ options: [], current: null, currentLabel: 'Pending changes', fileCount: 3, onSelect: () => {} }}
            onSelectView={() => {}} onBack={() => {}} onStartReview={() => {}} onProposeCommits={onPropose}
            sections={[
                { id: 'find', items: [{ id: 'open', title: 'find.surface.changes' }], onSelect: onFind },
                { id: 'display', title: 'Display', items: [{ id: 'wrap', title: 'Wrap lines', checked: true }], onSelect: onDisplay },
            ]} />);
        const menu = screen.root.find((node) => node.type === DropdownMenu && node.props.testID === 'scm-comparison-phone-actions');
        const titles = (menu.props.items as { title: string }[]).map((item) => item.title);
        expect(titles.filter((title) => title === 'scmComparison.proposeCommits')).toHaveLength(1);
        expect(titles).toContain('find.surface.changes');
        expect(titles).toContain('Wrap lines');
        expect(menu.props.footer).toBeUndefined();
        expect(menu.props.showCategoryTitles).toBe(true);
        const idOf = (title: string) => (menu.props.items as { id: string; title: string }[]).find((item) => item.title === title)!.id;
        React.act(() => { menu.props.onSelect(idOf('find.surface.changes')); menu.props.onSelect(idOf('Wrap lines')); });
        expect(onFind).toHaveBeenCalledWith('open');
        expect(onDisplay).toHaveBeenCalledWith('wrap');
    });
    it('offers Back only when the host can leave the comparison', async () => {
        const { ScmComparisonPhoneHeader } = await import('./ScmComparisonPhoneHeader');
        const scope = { options: [], current: null, currentLabel: 'Pending changes', fileCount: 0, onSelect: () => {} };
        const leave = vi.fn();
        const closable = await renderScreen(<ScmComparisonPhoneHeader view="files" views={['files', 'walkthrough']} scope={scope}
            onSelectView={() => {}} onBack={leave} onStartReview={() => {}} />);
        await closable.pressByTestIdAsync('scm-comparison-phone-back');
        expect(leave).toHaveBeenCalledOnce();
        // A companion beside Code has nowhere to go back to: no arrow that does nothing.
        const companion = await renderScreen(<ScmComparisonPhoneHeader view="files" views={['files', 'walkthrough']} scope={scope}
            onSelectView={() => {}} onStartReview={() => {}} />);
        expect(companion.findByTestId('scm-comparison-phone-back')).toBeNull();
    });
});
