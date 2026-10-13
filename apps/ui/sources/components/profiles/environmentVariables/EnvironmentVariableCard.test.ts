import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import React from 'react';
import { renderScreen } from '@/dev/testkit';
import { installProfilesCommonModuleMocks } from '../profilesTestHelpers';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

installProfilesCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Pressable: 'Pressable',
            TextInput: 'TextInput',
        });
    },
});
vi.doUnmock('@/sync/domains/state/storage');
const { Switch } = await import('@/components/ui/forms/Switch');
const { EnvironmentVariableCard } = await import('./EnvironmentVariableCard');

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));




type RenderedCard = Awaited<ReturnType<typeof renderScreen>>;

async function renderCard(params: {
    value: string;
    onUpdate: ReturnType<typeof vi.fn<(index: number, next: string) => void>>;
}): Promise<RenderedCard> {
    return renderScreen(
        React.createElement(EnvironmentVariableCard, {
            variable: { name: 'FOO', value: params.value },
            index: 0,
            machineId: 'machine-1',
            onUpdate: params.onUpdate,
            onDelete: () => {},
            onDuplicate: () => {},
        }),
    );
}

function findTextInputs(screen: RenderedCard) {
    return screen.findAllByType('TextInput');
}

function findUseMachineSwitch(screen: RenderedCard) {
    const switches = screen.findAllByType(Switch);
    return switches.find((node) => node.props.disabled !== true);
}

describe('EnvironmentVariableCard', () => {
    describe('remote-template state synchronization', () => {
        it('syncs remote-variable toggle state when variable value changes externally', async () => {
            const onUpdate = vi.fn<(index: number, next: string) => void>();
            const screen = await renderCard({ value: '${BAR:-baz}', onUpdate });

            const initialUseMachineSwitch = findUseMachineSwitch(screen);
            expect(initialUseMachineSwitch?.props.value).toBe(true);

            await act(async () => {
                screen.tree.update(
                    React.createElement(EnvironmentVariableCard, {
                        variable: { name: 'FOO', value: 'literal' },
                        index: 0,
                        machineId: 'machine-1',
                        onUpdate,
                        onDelete: () => {},
                        onDuplicate: () => {},
                    }),
                );
            });

            const updatedUseMachineSwitch = findUseMachineSwitch(screen);
            expect(updatedUseMachineSwitch?.props.value).toBe(false);
        });
    });

    describe('fallback template transformation', () => {
        it('adds a fallback operator when user enters fallback for template without one', async () => {
            const onUpdate = vi.fn<(index: number, next: string) => void>();
            const screen = await renderCard({ value: '${BAR}', onUpdate });

            const [fallbackInput] = findTextInputs(screen);
            expect(fallbackInput).toBeTruthy();

            await act(async () => {
                fallbackInput?.props.onChangeText?.('baz');
            });

            const lastCall = onUpdate.mock.calls.at(-1);
            expect(lastCall).toEqual([0, '${BAR:-baz}']);
        });

        it('removes operator when user clears existing fallback', async () => {
            const onUpdate = vi.fn<(index: number, next: string) => void>();
            const screen = await renderCard({ value: '${BAR:=baz}', onUpdate });

            const [fallbackInput] = findTextInputs(screen);
            expect(fallbackInput).toBeTruthy();

            await act(async () => {
                fallbackInput?.props.onChangeText?.('');
            });

            const lastCall = onUpdate.mock.calls.at(-1);
            expect(lastCall).toEqual([0, '${BAR}']);
        });
    });
});
