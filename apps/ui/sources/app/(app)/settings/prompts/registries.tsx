import React from 'react';
import { PromptRegistriesScreen } from '@/components/settings/prompts/registries/PromptRegistriesScreen';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

export const WorkspaceRouteBody = React.memo(function PromptRegistriesRoute() {
    const enabled = useFeatureEnabled('prompts.library');

    if (!enabled) {
        return null;
    }

    return <PromptRegistriesScreen />;
});
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
