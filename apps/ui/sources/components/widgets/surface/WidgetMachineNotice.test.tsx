import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { Text } from '@/components/ui/text/Text';
import { storage } from '@/sync/domains/state/storageStore';
import { WidgetFrameBodyNoticeContext, type WidgetFrameBodyNoticeSource } from '@/components/widgets/frame/widgetFrameBodyCaption';

import { WidgetMachineNoticeBoundary } from './WidgetMachineNotice';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    return createTextModuleMock();
});

afterEach(() => { standardCleanup(); });

function Lending(props: Readonly<{ notice: WidgetFrameBodyNoticeSource | null }>) {
    const lend = React.useContext(WidgetFrameBodyNoticeContext);
    React.useEffect(() => { lend?.(props.notice); }, [lend, props.notice]);
    return <Text testID="body">rows</Text>;
}

describe('WidgetMachineNoticeBoundary', () => {
    it('says what a body lent about its Machine above the body, once, and stops when the body withdraws it', async () => {
        const render = (notice: WidgetFrameBodyNoticeSource | null) => (
            <WidgetMachineNoticeBoundary testID="widget">
                <Lending notice={notice} />
            </WidgetMachineNoticeBoundary>
        );
        const screen = await renderScreen(render(null));
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByTestId('widget-machine-notice')).toBeNull();
        await screen.update(render(() => 'This operation is unavailable on Studio Mac.'));
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByTestId('widget-machine-notice')).not.toBeNull();
        expect(screen.getTextContent().split('This operation is unavailable on Studio Mac.')).toHaveLength(2);
        await screen.update(render(null));
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByTestId('widget-machine-notice')).toBeNull();
    });

    it('leaves, and returns, with the Machine: the lent wording is read again as the stores change', async () => {
        let sentence: string | undefined = 'This operation is unavailable on this machine.';
        const screen = await renderScreen(
            <WidgetMachineNoticeBoundary testID="widget"><Lending notice={() => sentence} /></WidgetMachineNoticeBoundary>,
        );
        await flushHookEffects({ cycles: 2 });
        expect(screen.getTextContent()).toContain('unavailable on this machine');
        sentence = 'This operation is unavailable on Studio Mac.';
        await act(async () => { storage.setState((state) => ({ ...state })); });
        expect(screen.getTextContent()).toContain('unavailable on Studio Mac');
        sentence = undefined;
        await act(async () => { storage.setState((state) => ({ ...state })); });
        expect(screen.findByTestId('widget-machine-notice')).toBeNull();
    });

    it('replaces the body with that one sentence and one action: the body stays mounted but is not shown, and Try again asks it afresh', async () => {
        let mounts = 0;
        function RefusedOnce() {
            const lend = React.useContext(WidgetFrameBodyNoticeContext);
            const [mount] = React.useState(() => ++mounts);
            React.useEffect(() => {
                if (mount === 1) lend?.(() => 'This operation is unavailable on Studio Mac.');
                return () => lend?.(null);
            }, [lend, mount]);
            return <Text testID="plugin-error">The latest entries could not be read</Text>;
        }
        const screen = await renderScreen(<WidgetMachineNoticeBoundary testID="widget"><RefusedOnce /></WidgetMachineNoticeBoundary>);
        await flushHookEffects({ cycles: 2 });
        const body = screen.findByTestId('widget-body');
        expect(body?.props.style).toMatchObject({ display: 'none' });
        expect(screen.findAllByTestId('widget-machine-notice-secondary-action')).toHaveLength(0);
        await act(async () => { screen.findByTestId('widget-machine-notice-action')!.props.onPress(); });
        await flushHookEffects({ cycles: 2 });
        expect(mounts).toBe(2);
        expect(screen.findByTestId('widget-machine-notice')).toBeNull();
        expect(screen.findByTestId('widget-body')?.props.style).not.toMatchObject({ display: 'none' });
    });
});
