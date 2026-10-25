import * as React from 'react';
import { act } from 'react-test-renderer';
import type { TestRendererOptions } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeferred } from '../hooks/createDeferred';
import { standardCleanup } from '../cleanup/standardCleanup';

vi.mock('react-test-renderer', async importOriginal => {
    const actual = await importOriginal<typeof import('react-test-renderer')>();
    return { ...actual, act: vi.fn(actual.act) };
});

afterEach(() => {
    standardCleanup();
});

describe('UI testkit render helpers', () => {
    it('notifies subscribers when only the provider wrapper commits', async () => {
        const { renderScreen } = await import('./renderScreen');
        const response = createDeferred<string>();
        function Provider({ children }: React.PropsWithChildren) {
            const [value, setValue] = React.useState('pending');
            React.useEffect(() => { void response.promise.then(setValue); }, []);
            return React.createElement(React.Fragment, null, children,
                React.createElement('Text', { testID: 'provider.value' }, value));
        }
        const screen = await renderScreen(React.createElement('View'), { wrapper: Provider });
        const commits = vi.fn();
        const unsubscribe = screen.subscribe(commits);
        await act(async () => { response.resolve('completed'); });
        expect(screen.findByTestId('provider.value')?.children).toEqual(['completed']);
        expect(commits).toHaveBeenCalledOnce();
        unsubscribe();
    });

    it('preserves initial effect replay when the wrapper is StrictMode', async () => {
        const { renderScreen } = await import('./renderScreen');
        const lifecycle: string[] = [];
        function Leaf() {
            React.useEffect(() => {
                lifecycle.push('mounted');
                return () => { lifecycle.push('retired'); };
            }, []);
            return React.createElement('View');
        }
        const screen = await renderScreen(React.createElement(Leaf), { wrapper: React.StrictMode });
        expect(lifecycle).toEqual(['mounted', 'retired', 'mounted']);
        await screen.unmount();
        expect(lifecycle).toEqual(['mounted', 'retired', 'mounted', 'retired']);
    });

    it('notifies screen and tree subscribers when a descendant commits after asynchronous work', async () => {
        const { renderScreen } = await import('./renderScreen');
        const { waitForTestEvent } = await import('../hooks/waitForTestEvent');
        const response = createDeferred<string>();
        function AsyncLeaf() {
            const [value, setValue] = React.useState('pending');
            React.useEffect(() => { void response.promise.then(setValue); }, []);
            return React.createElement('Text', { testID: 'async.value' }, value);
        }
        const screen = await renderScreen(React.createElement(AsyncLeaf));
        const commits = vi.fn();
        const unsubscribe = screen.subscribe(commits);
        const completed = waitForTestEvent(screen.tree.subscribe,
            () => screen.findByTestId('async.value')?.children, value => value?.[0] === 'completed');
        await act(async () => { response.resolve('completed'); });
        expect(await completed).toEqual(['completed']);
        expect(commits).toHaveBeenCalledOnce();
        unsubscribe();
        await screen.update(React.createElement('Text', null, 'replacement'));
        expect(commits).toHaveBeenCalledOnce();
    });

    it('retires a created renderer when the SDK initial act rejects after mounting', async () => {
        const sdk = await import('react-test-renderer');
        const { renderWithAppProviders } = await import('./renderWithAppProviders');
        const originalAct = (await vi.importActual<typeof import('react-test-renderer')>('react-test-renderer')).act;
        const created = vi.spyOn(sdk.default, 'create');
        const failure = new Error('Renderer SDK initial flush failed');
        // React's renderer is the external SDK boundary. Keep the real tree and
        // effect lifecycle; fail only its initial flush acknowledgement.
        const asyncAct: (callback: () => Promise<void>) => Promise<undefined> = sdk.act;
        const initialAct = vi.mocked(asyncAct).mockImplementationOnce(callback =>
            Promise.resolve(originalAct(callback)).then(() => { throw failure; }));
        const lifecycle: string[] = [];
        function MountedOwner() {
            React.useEffect(() => {
                lifecycle.push('mounted');
                return () => { lifecycle.push('retired'); };
            }, []);
            return React.createElement('View');
        }
        try {
            await expect(renderWithAppProviders(React.createElement(MountedOwner))).rejects.toBe(failure);
            expect(lifecycle).toEqual(['mounted']);
            standardCleanup();
            expect(lifecycle).toEqual(['mounted', 'retired']);
        } finally {
            initialAct.mockImplementation(originalAct);
            const result = created.mock.results[0];
            if (result?.type === 'return') await originalAct(async () => { result.value.unmount(); });
            created.mockRestore();
        }
    });

    it('queries simple memo components through the screen and tree helpers', async () => {
        const { renderScreen } = await import('./renderScreen');
        const MemoControl = React.memo(function Control(props: { label: string }) {
            return React.createElement('Text', null, props.label);
        });
        const screen = await renderScreen(React.createElement(MemoControl, { label: 'memo control' }));

        expect(screen.findByType<typeof MemoControl>(MemoControl).props.label).toBe('memo control');
        expect(screen.findAllByType<typeof MemoControl>(MemoControl)).toHaveLength(1);
        expect(screen.tree.findByType<typeof MemoControl>(MemoControl).props.label).toBe('memo control');
        expect(screen.tree.findAllByType<typeof MemoControl>(MemoControl)).toHaveLength(1);
        expect(screen.root.findAllByType(MemoControl)).toHaveLength(0);
    });

    it('prefers exact custom memo wrapper matches over their inner components', async () => {
        const { renderScreen } = await import('./renderScreen');
        function Control(props: { label: string }) {
            return React.createElement('Text', null, props.label);
        }
        const MemoControl = React.memo(Control, (previous, next) => previous.label === next.label);
        const screen = await renderScreen(React.createElement(React.Fragment, null,
            React.createElement(MemoControl, { label: 'memo control' }),
            React.createElement(Control, { label: 'plain control' }),
        ));

        expect(screen.findByType<typeof MemoControl>(MemoControl).props.label).toBe('memo control');
        expect(screen.findAllByType<typeof MemoControl>(MemoControl)).toHaveLength(1);
        expect(screen.tree.findByType<typeof MemoControl>(MemoControl).props.label).toBe('memo control');
        expect(screen.tree.findAllByType<typeof MemoControl>(MemoControl)).toHaveLength(1);
    });

    it.each([
        { host: 'Pressable', idProp: 'testID', handlerProp: 'onPress' },
        { host: 'button', idProp: 'data-testid', handlerProp: 'onClick' },
    ])('drives the actionable $host host through a wrapper sharing its test id', async ({ host, idProp, handlerProp }) => {
        const { renderScreen } = await import('./renderScreen');

        function WrappedControl(props: { testID: string; onPress: () => void; onHostPress: () => void }) {
            return React.createElement(host, {
                [idProp]: props.testID,
                [handlerProp]: props.onHostPress,
            });
        }

        function Counter() {
            const [count, setCount] = React.useState(0);
            return React.createElement('View', null,
                React.createElement(WrappedControl, {
                    testID: 'settings.row',
                    onPress: () => setCount(100),
                    onHostPress: () => setCount((current) => current + 1),
                }),
                React.createElement('Text', { testID: 'settings.count' }, String(count)),
            );
        }

        const screen = await renderScreen(React.createElement(Counter));
        expect(screen.findByTestId('settings.row')?.type).toBe(host);
        expect(screen.findAllByTestId('settings.row')).toHaveLength(2);
        expect(screen.findAllHostsByTestId('settings.row')).toHaveLength(1);

        await act(async () => screen.pressByTestId('settings.row'));
        expect(screen.findHostByTestId('settings.count')?.children).toEqual(['1']);
        await act(async () => screen.tree.pressByTestId('settings.row'));
        expect(screen.findHostByTestId('settings.count')?.children).toEqual(['2']);
    });

    it('awaits async press handlers through the screen helper', async () => {
        const { renderScreen } = await import('./renderScreen');

        const events: string[] = [];
        const started = createDeferred<void>();
        const release = createDeferred<void>();
        function AsyncControl() {
            const [status, setStatus] = React.useState('idle');
            const onPress = async () => {
                events.push('started');
                started.resolve(undefined);
                await release.promise;
                setStatus('completed');
                events.push('completed');
            };
            return React.createElement('View', null,
                React.createElement('Pressable', { testID: 'settings.async', onPress }),
                React.createElement('Text', { testID: 'settings.status' }, status),
            );
        }
        const screen = await renderScreen(React.createElement(AsyncControl));

        let settled = false;
        const pressPromise = screen.pressByTestIdAsync('settings.async').then(() => {
            settled = true;
        });

        await started.promise;
        expect(settled).toBe(false);

        release.resolve(undefined);
        await pressPromise;
        expect(events).toEqual(['started', 'completed']);
        expect(screen.findHostByTestId('settings.status')?.children).toEqual(['completed']);
    });

    it('presses the visible control while an outgoing modal retains the same test id', async () => {
        const { renderScreen } = await import('./renderScreen');
        const livePress = vi.fn();
        const retiredPress = vi.fn();
        const screen = await renderScreen(React.createElement(React.Fragment, null,
            React.createElement('Pressable', { testID: 'start-run', onPress: livePress }),
            React.createElement('View', { visible: false },
                React.createElement('Pressable', { testID: 'start-run', onPress: retiredPress })),
        ));

        // Retained content stays queryable for custody and exit-motion assertions.
        expect(screen.findAllHostsByTestId('start-run')).toHaveLength(2);
        await act(async () => screen.pressByTestId('start-run'));
        await screen.tree.pressByTestIdAsync('start-run');
        expect(livePress).toHaveBeenCalledTimes(2);
        expect(retiredPress).not.toHaveBeenCalled();

        await screen.update(React.createElement('View', { visible: false },
            React.createElement('Pressable', { testID: 'start-run', onPress: retiredPress })));
        expect(screen.findByTestId('start-run')).not.toBeNull();
        expect(() => screen.pressByTestId('start-run')).toThrow(/hidden/);
        await expect(screen.pressByTestIdAsync('start-run')).rejects.toThrow(/hidden/);
        expect(retiredPress).not.toHaveBeenCalled();
    });

    it('presses a rendered host when a composite uses visible as a domain fact', async () => {
        const { renderScreen } = await import('./renderScreen');
        const onPress = vi.fn();
        function NavigationMarker(props: { visible: boolean; onPress: () => void }) {
            return React.createElement('Pressable', { testID: 'navigation.marker', onPress: props.onPress });
        }
        const screen = await renderScreen(React.createElement(NavigationMarker, { visible: false, onPress }));

        screen.pressByTestId('navigation.marker');
        await screen.pressByTestIdAsync('navigation.marker');
        expect(onPress).toHaveBeenCalledTimes(2);
    });

    it('queries rendered host instances without counting transparent composite wrappers', async () => {
        const { findAllHostTestInstances, renderScreen } = await import('./renderScreen');

        function ForwardingControl(props: Record<string, unknown>) {
            return React.createElement('Pressable', props);
        }

        const screen = await renderScreen(React.createElement(ForwardingControl, {
            role: 'switch',
            testID: 'settings.forwarded-control',
        }));

        expect(screen.findAll((node) => node.props?.role === 'switch')).toHaveLength(2);
        expect(findAllHostTestInstances(screen.root, (node) => node.props?.role === 'switch'))
            .toEqual([expect.objectContaining({ type: 'Pressable' })]);
    });

    it('exposes the same test id helpers on the underlying tree result, including text changes', async () => {
        const { renderScreen } = await import('./renderScreen');

        function TextEditor() {
            const [value, setValue] = React.useState('');
            return React.createElement('View', null,
                React.createElement('Pressable', { testID: 'settings.tree-row', onPress: () => setValue('pressed') }),
                React.createElement('TextInput', { testID: 'settings.tree-input', value, onChangeText: setValue }),
            );
        }
        const screen = await renderScreen(React.createElement(TextEditor));

        expect(screen.tree.findByTestId('settings.tree-row')).toBeTruthy();
        await act(async () => screen.tree.pressByTestId('settings.tree-row'));
        expect(screen.tree.findByTestId('settings.tree-input')?.props.value).toBe('pressed');
        await act(async () => screen.tree.changeTextByTestId('settings.tree-input', 'next value'));

        expect(screen.tree.findByTestId('settings.tree-input')?.props.value).toBe('next value');
    });

    it('drives a text control that reports edits only through the host onChange event', async () => {
        const { renderScreen } = await import('./renderScreen');

        // React Native's TextInput reports every edit through both `onChangeText`
        // and `onChange`. A control that needs the host event (IME composition
        // state travels on it) legitimately wires only `onChange`; the driver has
        // to reach it the same way the host does.
        function HostEventEditor() {
            const [value, setValue] = React.useState('');
            return React.createElement('TextInput', {
                testID: 'settings.change-only-input',
                value,
                onChange: (event: { nativeEvent: { text: string } }) => setValue(event.nativeEvent.text),
            });
        }
        const screen = await renderScreen(React.createElement(HostEventEditor));

        await act(async () => screen.changeTextByTestId('settings.change-only-input', 'typed value'));

        expect(screen.findByTestId('settings.change-only-input')?.props.value).toBe('typed value');
    });

    it('reports a text control that exposes no edit handler at all', async () => {
        const { renderScreen } = await import('./renderScreen');

        const screen = await renderScreen(
            React.createElement('View', { testID: 'settings.not-a-field' }),
        );

        expect(() => screen.changeTextByTestId('settings.not-a-field', 'typed value')).toThrow(
            /settings\.not-a-field/,
        );
    });

    it('presses a previously-found test instance through the shared standalone helpers', async () => {
        const { pressTestInstance, pressTestInstanceAsync, renderScreen } = await import('./renderScreen');

        const onPress = vi.fn(async () => undefined);
        const screen = await renderScreen(
            React.createElement(
                'View',
                null,
                React.createElement('Pressable', { testID: 'settings.instance-row', onPress }),
            ),
        );

        const target = screen.findByTestId('settings.instance-row');
        expect(target).toBeTruthy();

        pressTestInstance(target!, 'settings.instance-row');
        await pressTestInstanceAsync(target!, 'settings.instance-row');

        expect(onPress).toHaveBeenCalledTimes(2);
    });

    it('invokes arbitrary named handlers on a previously-found test instance through the shared standalone helper', async () => {
        const { invokeTestInstanceHandler, renderScreen } = await import('./renderScreen');

        const onPressIn = vi.fn();
        const screen = await renderScreen(
            React.createElement(
                'View',
                null,
                React.createElement('Pressable', { testID: 'settings.resize-handle', onPressIn }),
            ),
        );

        const target = screen.findByTestId('settings.resize-handle');
        expect(target).toBeTruthy();

        const event = {
            clientX: 320,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        };
        invokeTestInstanceHandler(target!, 'onPressIn', event, 'settings.resize-handle');

        expect(onPressIn).toHaveBeenCalledTimes(1);
        expect(onPressIn).toHaveBeenCalledWith(event);
    });

    it('finds typed instances by nested text content and changes text on a previously-found input instance', async () => {
        const {
            changeTextTestInstance,
            findTestInstanceByTypeContainingText,
            findTestInstanceByTypeWithProps,
            renderScreen,
        } = await import('./renderScreen');

        const onChangeText = vi.fn();
        const screen = await renderScreen(
            React.createElement(
                'View',
                null,
                React.createElement(
                    'Pressable',
                    { testID: 'review-findings-header:f1' },
                    React.createElement('Text', null, 'Severity: low'),
                    React.createElement('Text', null, 'Original finding'),
                ),
                React.createElement('TextInput', {
                    testID: 'review-findings-follow-up-input',
                    onChangeText,
                }),
            ),
        );

        const header = findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'Original finding');
        const input = screen.findByTestId('review-findings-follow-up-input');
        const namedInput = findTestInstanceByTypeWithProps(screen.tree, 'TextInput', {
            testID: 'review-findings-follow-up-input',
        });

        expect(header?.props.testID).toBe('review-findings-header:f1');
        expect(input).toBeTruthy();
        expect(namedInput?.props.testID).toBe('review-findings-follow-up-input');

        changeTextTestInstance(input!, 'Please clarify why this matters.', 'review-findings-follow-up-input');

        expect(onChangeText).toHaveBeenCalledWith('Please clarify why this matters.');
    });

    it('keeps the screen and tree queries current after replacing rendered content', async () => {
        const { renderScreen } = await import('./renderScreen');

        const content = (rowId: string) => React.createElement(
            'View',
            { testID: 'settings.root' },
            React.createElement('View', { testID: rowId }),
            React.createElement('Text', null, rowId),
        );
        const screen = await renderScreen(content('settings.previous-row'));

        for (const rowId of ['settings.previous-row', 'settings.current-row']) {
            if (rowId === 'settings.current-row') await screen.update(content(rowId));
            for (const queries of [screen, screen.tree]) {
                expect(queries.findByType('View').props.testID).toBe('settings.root');
                expect(queries.findAllByType('View')).toHaveLength(2);
                const row = queries.findByProps({ testID: rowId });
                expect(queries.findAllByProps({ testID: rowId })).toEqual([row]);
                expect(queries.find((node) => node.props?.testID === rowId)).toBe(row);
                expect(queries.findAll((node) => typeof node.type === 'string')).toHaveLength(3);
                expect(queries.findByTestId(rowId)).toBe(row);
            }
        }
        expect(screen.tree.findAllByProps({ testID: 'settings.previous-row' })).toEqual([]);
        expect(screen.findByTestId('settings.previous-row')).toBeNull();
    });

    it('collects text content through component wrapper children, not only host props.children', async () => {
        const { renderScreen } = await import('./renderScreen');

        function WrappedLabel() {
            return React.createElement(
                'View',
                null,
                React.createElement('Text', null, 'wrapped.title'),
            );
        }

        const screen = await renderScreen(React.createElement(WrappedLabel));

        expect(screen.getTextContent()).toContain('wrapped.title');
    });

    it('passes createNodeMock through the shared render helper options', async () => {
        const { renderScreen } = await import('./renderScreen');

        const portalHost = { nodeType: 1 };
        const ref = React.createRef<{ nodeType: number } | null>();
        const options: Parameters<typeof renderScreen>[1] & {
            createNodeMock: NonNullable<TestRendererOptions['createNodeMock']>;
        } = {
            createNodeMock: (element) => (
                (element as { props?: { testID?: string } }).props?.testID === 'settings.portal-host' ? portalHost : null
            ),
        };

        await renderScreen(
            React.createElement('View', { testID: 'settings.portal-host', ref }),
            options,
        );

        expect(ref.current).toBe(portalHost);
    });

    it('builds a settings view harness with stable row and group helpers', async () => {
        const { renderSettingsView } = await import('../harness/settingsViewHarness');

        const onBackendPress = vi.fn();
        const onAddPress = vi.fn();

        const screen = await renderSettingsView(
            React.createElement(
                'View',
                null,
                React.createElement('ItemGroup', { title: 'configured' },
                    React.createElement('Item', { testID: 'settings.backend.custom', title: 'Custom Backend', onPress: onBackendPress }),
                ),
                React.createElement('ItemGroup', { title: 'actions' },
                    React.createElement('Item', { testID: 'settings.addBackend', title: 'Add backend', onPress: onAddPress }),
                ),
            ),
        );

        expect(screen.findRow('settings.backend.custom')?.props.title).toBe('Custom Backend');
        expect(screen.findRowByTitle('Custom Backend')?.props.testID).toBe('settings.backend.custom');
        expect(screen.findGroup('configured')).toBeTruthy();
        expect(screen.listRows('settings.')).toHaveLength(2);

        screen.pressRow('settings.addBackend');
        screen.pressRowByTitle('Custom Backend');
        expect(onAddPress).toHaveBeenCalledTimes(1);
        expect(onBackendPress).toHaveBeenCalledTimes(1);
    });

    it('keeps settings row metadata distinct from its painted press target', async () => {
        const { renderSettingsView } = await import('../harness/settingsViewHarness');
        const onPress = vi.fn();
        function SettingsRow(props: { testID: string; title: string; detail: string; onPress: () => void }) {
            return React.createElement('Pressable', { testID: props.testID, onPress: props.onPress },
                React.createElement('Text', null, props.title));
        }
        const screen = await renderSettingsView(React.createElement(SettingsRow, {
            testID: 'settings.account', title: 'Account', detail: 'Connected', onPress,
        }));

        expect(screen.findRow('settings.account')?.props).toMatchObject({ title: 'Account', detail: 'Connected' });
        expect(screen.findHostByTestId('settings.account')?.type).toBe('Pressable');
        screen.pressRow('settings.account');
        expect(onPress).toHaveBeenCalledOnce();
    });

    it('prefers the interactive row when a settings title is shared by a group and an item', async () => {
        const { renderSettingsView } = await import('../harness/settingsViewHarness');

        const onPress = vi.fn();

        const screen = await renderSettingsView(
            React.createElement(
                'View',
                null,
                React.createElement('ItemGroup', { title: 'Duplicate Title' },
                    React.createElement('Item', {
                        testID: 'settings.duplicate',
                        title: 'Duplicate Title',
                        onPress,
                    }),
                ),
            ),
        );

        expect(screen.findRowByTitle('Duplicate Title')?.props.testID).toBe('settings.duplicate');

        screen.pressRowByTitle('Duplicate Title');
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('detects raw text outside allowed parents in renderer output, including empty input', async () => {
        const { collectUnexpectedRawTextNodes, renderScreen } = await import('./renderScreen');
        const screen = await renderScreen(React.createElement('View', null,
            'bad',
            React.createElement('Text', null, 'good'),
        ));

        expect(collectUnexpectedRawTextNodes(screen.tree.toJSON())).toEqual([
            { parent: 'View', value: 'bad' },
        ]);
        // Keep the empty-string boundary vector: React's renderer removes empty
        // children, but the collector must preserve them in a supplied host tree.
        expect(collectUnexpectedRawTextNodes({
            type: 'View',
            props: {},
            children: [''],
        })).toEqual([
            { parent: 'View', value: '' },
        ]);
    });
});
