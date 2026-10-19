import * as React from 'react';
import { Redirect, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useHappierCollectionIndexView } from '@happier-dev/plugin-ui/presentation';

import { ApiTokensSettingsScreen } from '../ApiTokensSettingsScreen';
import { showApiTokenCreateModal } from '../showApiTokenCreateModal';
import { useApiTokenSettingsControllerState } from '../useApiTokenSettingsControllerState';
import { apiTokenDetailPath, readLastVisitedApiToken, resolveApiTokenCollectionLanding } from './apiTokensCollection';
import { useApiTokenSettingsScopeController } from './ApiTokenSettingsScope';

/**
 * `/settings/account/api-tokens`. Beside the rail a token is always open, so the index lands on the
 * last opened or first one; where no rail shows, the index is the token list and each row pushes its
 * detail.
 */
export const ApiTokensSettingsIndex = React.memo(function ApiTokensSettingsIndex() {
    const view = useHappierCollectionIndexView();
    if (view === 'pending') return null;
    if (view === 'land') return <ApiTokenCollectionLanding />;
    return <ApiTokensSettingsScreen />;
});

const ApiTokenCollectionLanding = React.memo(function ApiTokenCollectionLanding() {
    const state = useApiTokenSettingsControllerState(useApiTokenSettingsScopeController());
    // Wait for the first list so "first token" is not a guess and the page does not flash first.
    if ((state.phase === 'idle' || state.phase === 'loading') && state.tokens.length === 0) return null;
    const landingId = resolveApiTokenCollectionLanding(state.tokens, readLastVisitedApiToken());
    if (landingId) return <Redirect href={apiTokenDetailPath(landingId) as never} />;
    // Beside the rail (which already lists every row) with nothing a token detail can open: only
    // embed-backed tokens, whose detail is Embeds. One calm empty state, never the list again.
    if (state.tokens.length > 0) return <ApiTokensEmbedOnlyEmptyState />;
    return <ApiTokensSettingsScreen />;
});

const ApiTokensEmbedOnlyEmptyState = React.memo(function ApiTokensEmbedOnlyEmptyState() {
    const controller = useApiTokenSettingsScopeController();
    const router = useRouter();
    return (
        <EmptyState
            testID="settings-api-tokens-embed-only"
            layout="page"
            variant="add"
            iconName="key"
            title={t('settingsApiTokens.embedOnlyTitle')}
            subtitle={t('settingsApiTokens.embedKeysElsewhere')}
            primaryAction={{ label: t('settingsApiTokens.create.button'), testID: 'settings-api-tokens-embed-only-create', onPress: () => { showApiTokenCreateModal(controller); } }}
            secondaryAction={{ label: t('settingsApiTokens.openEmbeds'), testID: 'settings-api-tokens-open-embeds', onPress: () => {
                const result = runGuardedNavigation(() => router.push(SETTINGS_ROUTES.embeds as never));
                if (result !== true) fireAndForget(result, { tag: 'ApiTokensEmbedOnlyEmptyState.openEmbeds' });
            } }}
        />
    );
});
