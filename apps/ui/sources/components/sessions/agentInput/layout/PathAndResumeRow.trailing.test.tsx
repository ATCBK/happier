import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('Pressable', props, props.children),
        Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('Text', props, props.children),
    });
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => <>{'.'}</> }));
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
}));

const styles = { pathRow: {}, actionButtonsLeft: {}, actionChip: {}, actionChipIconOnly: {}, actionChipPressed: {}, actionChipText: {} };

describe('PathAndResumeRow location order', () => {
    it('renders the machine first, then the folder and resume, then the trailing location controls', async () => {
        const { PathAndResumeRow } = await import('./PathAndResumeRow');
        const control = (id: string) => React.createElement('Pressable', { key: id, testID: id });
        const screen = await renderScreen(<PathAndResumeRow
            styles={styles}
            showChipLabels
            iconColor="#000"
            folderChipState={{ kind: 'folder', path: '/workspace/project' }}
            resumeSessionId="session-1"
            resumeLabelTitle="Resume session"
            resumeLabelOptional="Resume: Optional"
            onPathClick={() => {}}
            onResumeClick={() => {}}
            leadingControls={[control('machine')]}
            trailingControls={[control('checkout'), control('automate')]}
        />);

        const order = screen.findAll((node) => typeof node.type === 'string' && [
            'machine', 'agent-input-path-chip', 'agent-input-resume-chip', 'checkout', 'automate',
        ].includes(node.props.testID)).map((node) => node.props.testID);
        expect(order).toEqual(['machine', 'agent-input-path-chip', 'agent-input-resume-chip', 'checkout', 'automate']);
    });
});
