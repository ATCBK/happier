import * as React from 'react';
import { usePathname } from '@/components/appShell/workspace/destinationRoute';
import { useHappierCollectionVisit } from '@happier-dev/plugin-ui/presentation';

import { resolveSettingsNestedRouteName } from '@/components/settings/navigation/settingsRouteRegistry';
import { SettingsCollectionLayout } from '@/components/settings/shell/SettingsCollectionLayout';

import { useApiTokenSettingsControllerSelector } from '../useApiTokenSettingsControllerState';
import { API_TOKENS_COLLECTION_ROOT, recordApiTokenCollectionVisit, resolveSelectedApiTokenId } from './apiTokensCollection';
import { ApiTokensCollectionRail } from './ApiTokensCollectionRail';
import { ApiTokenSettingsScope, useApiTokenSettingsScopeController } from './ApiTokenSettingsScope';

/** The narrowest token detail that still fits a fact row beside its value. */
const API_TOKENS_DETAIL_MIN_WIDTH_PX = 480;

function resolveApiTokensChildRoute(pathname: string): string {
    return resolveSettingsNestedRouteName('account/api-tokens', pathname) ?? 'index';
}

const keyOf = (tokenId: string) => tokenId;
const selectHasTokens = (state: Readonly<{ tokens: readonly unknown[] }>) => state.tokens.length > 0;

/**
 * API tokens as a collection (plan 01 §6.1). Wide: the tokens rail beside the open token. Narrow, or
 * with no tokens yet: the list page alone, which pushes each token's detail.
 */
export const ApiTokensSettingsLayout = React.memo(function ApiTokensSettingsLayout() {
    return (
        <ApiTokenSettingsScope>
            <ApiTokensCollection />
        </ApiTokenSettingsScope>
    );
});

const ApiTokensCollection = React.memo(function ApiTokensCollection() {
    const controller = useApiTokenSettingsScopeController();
    const hasTokens = useApiTokenSettingsControllerSelector(controller, selectHasTokens);
    useHappierCollectionVisit(recordApiTokenCollectionVisit, resolveSelectedApiTokenId(usePathname().replace(/\/+$/, '')), keyOf);
    return (
        <SettingsCollectionLayout
            navigator="account/api-tokens"
            rootPathname={API_TOKENS_COLLECTION_ROOT}
            resolveChildRoute={resolveApiTokensChildRoute}
            // An empty collection is its page: no rail beside an empty state.
            rail={hasTokens ? <ApiTokensCollectionRail /> : null}
            railWidth="standard"
            detailMinWidthPx={API_TOKENS_DETAIL_MIN_WIDTH_PX}
            testID="settings-api-tokens"
        />
    );
});
