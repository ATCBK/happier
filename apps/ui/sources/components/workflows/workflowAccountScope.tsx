import * as React from 'react';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

/** Carries an already-resolved route binding through the mounted editor's reference controls. */
const WorkflowAccountLifetime = React.createContext<ServerAccountScopeLifetime | null | undefined>(undefined);
export const WorkflowAccountLifetimeProvider = WorkflowAccountLifetime.Provider;
export function useWorkflowAccountLifetime(explicit?: ServerAccountScopeLifetime | null): ServerAccountScopeLifetime | null | undefined {
    const inherited = React.useContext(WorkflowAccountLifetime);
    return explicit === undefined ? inherited : explicit;
}
