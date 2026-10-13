import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PageLeaveActions } from './PageLeaveActions';
import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

afterEach(() => {
    standardCleanup();
});

describe('PageLeaveActions', () => {
    it('puts the action that cannot be undone last and its consequence after it', async () => {
        const screen = await renderScreen(
            <PageLeaveActions
                testID="leave"
                footnote="Erasing removes its data for good."
                actions={[
                    { testID: 'erase', label: 'Erase data', display: 'destructive', onPress: () => undefined },
                    { testID: 'uninstall', label: 'Uninstall', display: 'bordered', icon: 'trash', onPress: () => undefined },
                    { testID: 'forget', label: 'Forget trust', display: 'text', onPress: () => undefined },
                ]}
            />,
        );
        const order = screen
            .findAll((node) => ['erase', 'uninstall', 'forget', 'leave:footnote'].includes(node.props?.testID))
            .map((node) => node.props.testID as string)
            .filter((id, index, all) => all.indexOf(id) === index);
        expect(order).toEqual(['uninstall', 'forget', 'erase', 'leave:footnote']);
    });
});
