import * as React from 'react';
import { useCompactAppDestinationCatalog } from '../destinations/compactAppDestinationCatalog';
import { WorkspaceProvider } from './WorkspaceProvider';
import { useWorkspacePresentation } from './useWorkspaceShellEnabled';

/** Above the palette and rail so every workspace launcher reaches the same owner. */
export function WorkspaceAppShellProvider(props: Readonly<{ children: React.ReactNode }>) {
    const { destinations: catalog, ready, accountLifetime } = useCompactAppDestinationCatalog();
    const presentation = useWorkspacePresentation();
    const admittedLifetime = React.useRef<typeof accountLifetime | undefined>(undefined);
    React.useLayoutEffect(() => {
        if (ready && (!accountLifetime || accountLifetime.isCurrent())) admittedLifetime.current = accountLifetime;
    }, [accountLifetime, ready]);
    // The first URL and restored tabs must see this exact source before their state initializes.
    // Once admitted, a current Account keeps its workspace and editors through source refreshes.
    if ((accountLifetime && !accountLifetime.isCurrent()) || (!ready && admittedLifetime.current !== accountLifetime)) return null;
    return <WorkspaceProvider enabled={presentation === 'shell'} phone={presentation === 'phone'}
        entry={presentation === 'entry'} deferred={presentation === 'deferred'} catalog={catalog}>
        {props.children}
    </WorkspaceProvider>;
}
