import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { NavigationContext } from '@react-navigation/native';

import { createRenderCommitCounter, renderScreen, useRenderCommitCounter } from '@/dev/testkit';
import { createNavigationPropMock } from '@/dev/testkit/mocks/reactNavigation';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { CollectionDraftTitleScope, useCollectionDraftTitle } from './CollectionDraftTitle';

// The global native boundary fixes focus at true; retain the installed SDK's real focus subscription.
vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    const { NavigationContext, useIsFocused } = await vi.importActual<typeof import('@react-navigation/native')>('@react-navigation/native');
    return { ...createReactNavigationNativeMock(), NavigationContext, useIsFocused };
});

function Publisher(props: Readonly<{ title: string }>): React.ReactElement | null {
    const { publish } = useCollectionDraftTitle();
    React.useEffect(() => { publish(props.title); }, [publish, props.title]);
    React.useEffect(() => () => publish(''), [publish]);
    return null;
}

function Observer(props: Readonly<{ record: (title: string) => void }>): React.ReactElement | null {
    const title = useCollectionDraftTitle().useTitle();
    React.useEffect(() => { props.record(title); }, [props.record, title]);
    return null;
}

const CountedObserver = React.memo(function CountedObserver(props: Readonly<{
    record: (title: string) => void;
    counter: ReturnType<typeof createRenderCommitCounter>;
}>): React.ReactElement | null {
    useRenderCommitCounter(props.counter);
    const title = useCollectionDraftTitle().useTitle();
    React.useEffect(() => { props.record(title); }, [props.record, title]);
    return null;
});

function CallbackPublisher(props: Readonly<{ testID: string }>): React.ReactElement {
    const { publish } = useCollectionDraftTitle();
    React.useEffect(() => () => publish(''), [publish]);
    return React.createElement('DraftInput', { testID: props.testID, onChangeText: publish });
}

describe('Collection draft title presentation', () => {
    it('follows the native Stack screen focus when the enclosing Settings layout remains presented', async () => {
        const observed: string[] = [];
        const record = (title: string) => { observed.push(title); };
        const page = (focused: boolean, title: string) => <CollectionDraftTitleScope>
            <Observer record={record} />
            <PluginSurfaceFocusEligibilityProvider active>
                <NavigationContext.Provider value={createNavigationPropMock({ isFocused: () => focused })}>
                    <Publisher title={title} />
                </NavigationContext.Provider>
            </PluginSurfaceFocusEligibilityProvider>
        </CollectionDraftTitleScope>;
        const screen = await renderScreen(page(false, 'Hidden native gateway'));
        expect(observed).toEqual(['']);
        await screen.update(page(true, 'Visible native draft'));
        expect(observed).toEqual(['', 'Visible native draft']);
        await screen.update(page(false, 'Changed hidden native draft'));
        expect(observed).toEqual(['', 'Visible native draft']);
        await screen.update(page(true, 'Changed hidden native draft'));
        expect(observed).toEqual(['', 'Visible native draft', 'Changed hidden native draft']);
        await screen.unmount();
    });

    it('publishes only presented titles and publishes the current title when a retained draft reopens', async () => {
        const observed: string[] = [];
        const counter = createRenderCommitCounter();
        const record = (title: string) => { observed.push(title); };
        const page = (visible: boolean, title: string) => <CollectionDraftTitleScope>
            <CountedObserver record={record} counter={counter} />
            <PluginSurfaceFocusEligibilityProvider active={visible} presentationActive={visible}>
                <Publisher title={title} />
            </PluginSurfaceFocusEligibilityProvider>
        </CollectionDraftTitleScope>;
        const screen = await renderScreen(page(false, 'Hidden gateway'));
        expect(observed).toEqual(['']);
        await screen.update(page(true, 'Main gateway'));
        expect(observed).toEqual(['', 'Main gateway']);
        counter.reset();
        await screen.update(page(false, 'Main gateway'));
        await screen.update(page(false, 'Changed while hidden'));
        expect(observed).toEqual(['', 'Main gateway']);
        expect(counter.read()).toEqual({ renders: 0, commits: 0 });
        await screen.update(page(true, 'Changed while hidden'));
        expect(observed).toEqual(['', 'Main gateway', 'Changed while hidden']);
        await screen.unmount();
    });

    it('keeps a hidden retained publisher from replacing or clearing another visible draft', async () => {
        const observed: string[] = [];
        const record = (title: string) => { observed.push(title); };
        const page = (hiddenTitle: string | null, accountActive = true) => <CollectionDraftTitleScope>
            <Observer record={record} />
            <PluginSurfaceFocusEligibilityProvider active={accountActive}>
                <Publisher title="New ChatGPT account" />
            </PluginSurfaceFocusEligibilityProvider>
            {hiddenTitle !== null ? <PluginSurfaceFocusEligibilityProvider active={!accountActive}>
                <Publisher title={hiddenTitle} />
            </PluginSurfaceFocusEligibilityProvider> : null}
        </CollectionDraftTitleScope>;
        const screen = await renderScreen(page('ChatGPT', false));
        expect(observed).toEqual(['', 'ChatGPT']);
        await screen.update(page('ChatGPT'));
        expect(observed).toEqual(['', 'ChatGPT', 'New ChatGPT account']);
        await screen.update(page('A different hidden gateway'));
        await screen.update(page(null));
        expect(observed).toEqual(['', 'ChatGPT', 'New ChatGPT account']);
        await screen.unmount();
    });

    it('restores callback-published editor intent on focus handoff without letting rail readers replay a title', async () => {
        const observed: string[] = [];
        const record = (title: string) => { observed.push(title); };
        const page = (accountActive: boolean, readerActive: boolean) => <CollectionDraftTitleScope>
            <Observer record={record} />
            <PluginSurfaceFocusEligibilityProvider active={accountActive}>
                <CallbackPublisher testID="account-draft" />
            </PluginSurfaceFocusEligibilityProvider>
            <PluginSurfaceFocusEligibilityProvider active={!accountActive}>
                <CallbackPublisher testID="gateway-draft" />
            </PluginSurfaceFocusEligibilityProvider>
            <PluginSurfaceFocusEligibilityProvider active={readerActive}>
                <Observer record={() => {}} />
            </PluginSurfaceFocusEligibilityProvider>
        </CollectionDraftTitleScope>;
        const screen = await renderScreen(page(true, false));
        const publishAccount = screen.findHostByTestId('account-draft')!.props.onChangeText;
        const publishGateway = screen.findHostByTestId('gateway-draft')!.props.onChangeText;
        await act(async () => { publishAccount('Work account'); });
        await act(async () => { publishGateway('Hidden gateway'); });
        expect(observed).toEqual(['', 'Work account']);
        await screen.update(page(false, false));
        expect(observed).toEqual(['', 'Work account', 'Hidden gateway']);
        await screen.update(page(false, true));
        expect(observed).toEqual(['', 'Work account', 'Hidden gateway']);
        await screen.update(page(true, true));
        expect(observed).toEqual(['', 'Work account', 'Hidden gateway', 'Work account']);
        expect(screen.findHostByTestId('account-draft')!.props.onChangeText).toBe(publishAccount);
        await screen.unmount();
    });
});
