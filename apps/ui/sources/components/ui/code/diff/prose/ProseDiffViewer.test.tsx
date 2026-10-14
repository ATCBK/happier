import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
const { DiffViewer } = await import('../DiffViewer');
const { Text } = await import('@/components/ui/text/Text');
afterEach(() => { standardCleanup(); });

const labels = { oldLabel: <Text>Yours</Text>, newLabel: <Text>Theirs</Text> };

it('renders the prose face as two labelled sides with no code-diff hunk header', async () => {
    const screen = await renderScreen(<DiffViewer mode="text" face="prose" testID="prose" presentationStyleOverride="split"
        oldText={'a\nWarn above 2 GB.\nc\n'} newText={'a\nWarn above 1 GB.\nc\n'} prose={{ ...labels, kept: 'old' }} />);
    const text = screen.getTextContent();
    expect(text).toContain('Yours');
    expect(text).toContain('Theirs');
    expect(text).toContain('Warn above 2 GB.');
    expect(text).toContain('Warn above 1 GB.');
    expect(text).not.toContain('@@');
});

it('shows only the side that has the file when the other has none', async () => {
    const screen = await renderScreen(<DiffViewer mode="text" face="prose" testID="prose"
        oldText="" newText={'import sys\n'} prose={labels} />);
    expect(screen.getTextContent()).toContain('Theirs');
    expect(screen.getTextContent()).not.toContain('Yours');
});
