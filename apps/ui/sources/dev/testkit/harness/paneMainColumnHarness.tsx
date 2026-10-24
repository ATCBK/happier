import * as React from 'react';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { AppPaneScopeHost } from '@/components/appShell/panes/AppPaneScopeHost';
import { usePaneMainColumn, type PaneMainColumnDescriptor } from '@/components/appShell/panes/mainColumn/usePaneMainColumn';
import { renderScreen } from '../render/renderScreen';

/** Replays real destination descriptors through the shell's actual context publication seam. */
export async function renderPaneMainColumnConsumer(descriptor: PaneMainColumnDescriptor) {
    let executions = 0;
    let current: ReturnType<typeof usePaneMainColumn> = null;
    const Consumer = React.memo(function Consumer() {
        executions += 1;
        current = usePaneMainColumn();
        return null;
    });
    const main = <Consumer />;
    const host = (mainColumn: PaneMainColumnDescriptor) => <AppPaneProvider>
        <AppPaneScopeHost scopeId="pane-identity-contract" mainColumn={mainColumn} main={main} />
    </AppPaneProvider>;
    const screen = await renderScreen(host(descriptor));
    return {
        reset: () => { executions = 0; },
        read: () => ({ executions, current }),
        publish: (next: PaneMainColumnDescriptor) => screen.update(host(next)),
    };
}
