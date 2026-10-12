import * as React from 'react';
import { Redirect, useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

import { ProviderConnectionDetailScreen } from '@/components/settings/providers/ProviderConnectionDetailScreen';
import { ProviderCustomConnectionEditScreen } from '@/components/settings/providers/ProviderConnectionAuthoringScreen';
import { PROVIDER_CONNECTION_MODELS_SECTION, providerConnectionModelsRoute } from '@/components/settings/providers/collection/providerCollectionModel';

function readParam(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

export function ProviderConnectionRoute() {
    const params = useLocalSearchParams<{
        connectionId?: string | string[];
        section?: string | string[];
        add?: string | string[];
        connected?: string | string[];
        edit?: string | string[];
    }>();
    const connectionId = readParam(params.connectionId) ?? '';
    // A saved custom connection opens in the same editor it was added with (F08).
    if (readParam(params.edit) === '1') return <ProviderCustomConnectionEditScreen connectionId={connectionId} />;
    // Older links opened the detail on its Models section; the models are their own page now.
    if (readParam(params.section) === PROVIDER_CONNECTION_MODELS_SECTION) {
        return <Redirect href={providerConnectionModelsRoute(connectionId, { add: readParam(params.add) === '1' }) as never} />;
    }
    return (
        <ProviderConnectionDetailScreen
            connectionId={connectionId}
            justConnected={readParam(params.connected) === '1'}
        />
    );
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { ProviderConnectionRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={ProviderConnectionRoute} />; }
