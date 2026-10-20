import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installAppPaneScopeHostCommonModuleMocks } from './appPaneScopeHostTestHelpers';

let width = 1200;
installAppPaneScopeHostCommonModuleMocks({
    getDimensions: () => ({ width, height: 900 }),
    getLocalSetting: key => key === 'rightPaneWidthPx' ? 360 : null,
});
const { AppPaneProvider, useAppPaneContext } = await import('./AppPaneProvider');
const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
const { MultiPaneHostWithBottom } = await import('@/components/ui/panels/MultiPaneHostWithBottom');

const rightAdapter = { destinationIds: ['right'], defaultDestinationId: 'right', render: () => <div /> };
function Main() {
    const { dispatch } = useAppPaneContext();
    React.useEffect(() => {
        dispatch({ type: 'openRight', scopeId: 'app' });
        dispatch({ type: 'setMainHidden', scopeId: 'app', hidden: true });
    }, [dispatch]);
    return <div />;
}

describe('AppPaneScopeHost hidden main sizing', () => {
    it.each([1200, 1800])('fills the remaining %i px host budget without a global pane cap', async (hostWidth) => {
        width = hostWidth;
        const screen = await renderScreen(<AppPaneProvider><AppPaneScopeHost
            scopeId="app" main={<Main />}
            mainColumn={{ hideLabel: 'Hide page', showLabel: 'Show page', identity: 'Page' }}
            rightPaneBuiltinAdapter={rightAdapter}
            destinationDetails={{ pane: <div />, onClose: () => {} }}
        /></AppPaneProvider>);
        const paneHost = screen.root.findByType(MultiPaneHostWithBottom);
        expect(paneHost.props.layout.right).toBe('docked');
        expect(paneHost.props.layout.details).toBe('docked');
        expect(paneHost.props.rightDockWidthPx).toBe(360);
        expect(paneHost.props.detailsDockWidthPx).toBe(hostWidth - 360);
        await screen.unmount();
    });
});
