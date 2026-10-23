import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { SecretKeyEntryForm } from './SecretKeyEntryForm';

const native = vi.hoisted(() => ({ platform: 'ios' as 'ios' | 'android' }));
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' }, {
        Platform: {
            get OS() { return native.platform; },
            select: <T,>(options: { ios?: T; android?: T; native?: T; default?: T }) => (
                options[native.platform] ?? options.native ?? options.default
            ),
        },
    });
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

it.each(['ios', 'android'] as const)('keeps %s recovery entry secure with autofill disabled across reveal and hide', async (platform) => {
    native.platform = platform;
    const screen = await renderScreen(
        <SecretKeyEntryForm description="Account key" submitTitle="Continue"
            onSubmit={async () => ({ kind: 'completed' })} />,
    );
    try {
        await act(async () => {
            screen.changeTextByTestId('restore-manual-secret-input', 'synthetic-recovery-key-for-secure-entry');
        });
        const input = () => screen.findByTestId('restore-manual-secret-input')!;
        expect(input().props.secureTextEntry).toBe(true);
        expect(input().props.multiline).toBe(false);
        expect(input().props.autoComplete).toBe('off');

        await screen.pressByTestIdAsync('restore-manual-secret-reveal');
        expect(input().props.secureTextEntry).toBe(false);
        expect(input().props.autoComplete).toBe('off');

        await screen.pressByTestIdAsync('restore-manual-secret-reveal');
        expect(input().props.secureTextEntry).toBe(true);
        expect(input().props.autoComplete).toBe('off');
        expect(input().props.value).toBe('synthetic-recovery-key-for-secure-entry');
    } finally {
        await screen.unmount();
    }
});
