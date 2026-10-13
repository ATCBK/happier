import * as React from 'react';
import { useHappierCollectionVisit } from '@happier-dev/plugin-ui/presentation';
import { usePathname } from '@/components/appShell/workspace/destinationRoute';

import { ApiTokenSettingsScope, useApiTokenSettingsScopeController } from '@/components/settings/apiTokens/collection/ApiTokenSettingsScope';
import { useApiTokenSettingsControllerSelector } from '@/components/settings/apiTokens/useApiTokenSettingsControllerState';
import { resolveSettingsNestedRouteName } from '@/components/settings/navigation/settingsRouteRegistry';
import { SettingsCollectionLayout } from '@/components/settings/shell/SettingsCollectionLayout';

import { EmbedsCollectionRail } from './EmbedsCollectionRail';
import { EMBED_DETAIL_TWO_COLUMN_MIN_WIDTH_PX, EMBEDS_COLLECTION_ROOT, isEmbedToken, recordEmbedCollectionVisit, resolveSelectedEmbedTokenId } from './embedsCollection';


function resolveEmbedsChildRoute(pathname: string): string {
    return resolveSettingsNestedRouteName('embeds', pathname) ?? 'index';
}

const keyOf = (tokenId: string) => tokenId;
const selectHasEmbeds = (state: Readonly<{ tokens: readonly Parameters<typeof isEmbedToken>[0][] }>) => state.tokens.some(isEmbedToken);

/**
 * Settings → Embeds (plan 04 §4.10, EH-R11). An embed is an API token with an embed configuration,
 * so the collection shares the API token controller (one list, one create/reveal/update/revoke
 * lifecycle) with Settings → API tokens.
 */
export const EmbedSettingsLayout = React.memo(function EmbedSettingsLayout() {
    return (
        <ApiTokenSettingsScope>
            <EmbedsCollection />
        </ApiTokenSettingsScope>
    );
});

const EmbedsCollection = React.memo(function EmbedsCollection() {
    const controller = useApiTokenSettingsScopeController();
    const hasEmbeds = useApiTokenSettingsControllerSelector(controller, selectHasEmbeds);
    useHappierCollectionVisit(recordEmbedCollectionVisit, resolveSelectedEmbedTokenId(usePathname().replace(/\/+$/, '')), keyOf);
    return (
        <SettingsCollectionLayout
            navigator="embeds"
            rootPathname={EMBEDS_COLLECTION_ROOT}
            resolveChildRoute={resolveEmbedsChildRoute}
            // No embeds yet: the page is its empty state, with no rail beside it.
            rail={hasEmbeds ? <EmbedsCollectionRail /> : null}
            railWidth="standard"
            // Inside the settings modal the collection pushes its detail; a wider window places the rail beside it.
            detailMinWidthPx={EMBED_DETAIL_TWO_COLUMN_MIN_WIDTH_PX}
            testID="settings-embeds"
        />
    );
});
