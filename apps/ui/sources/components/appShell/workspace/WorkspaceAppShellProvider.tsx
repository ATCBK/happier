import * as React from 'react';
import { useCompactAppDestinations } from '../destinations/compactAppDestinationCatalog';
import { WorkspaceProvider } from './WorkspaceProvider';
import { useWorkspacePresentation } from './useWorkspaceShellEnabled';

/** Above the palette and rail so every workspace launcher reaches the same owner. */
export function WorkspaceAppShellProvider(props: Readonly<{ children: React.ReactNode }>) {
    const catalog = useCompactAppDestinations();
    const presentation = useWorkspacePresentation();
    return <WorkspaceProvider enabled={presentation === 'shell'} phone={presentation === 'phone'}
        deferred={presentation === 'deferred'} catalog={catalog}>
        {props.children}
    </WorkspaceProvider>;
}
