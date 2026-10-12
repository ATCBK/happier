import * as React from 'react';
import { useHappierCollectionIndexView } from '@happier-dev/plugin-ui/presentation';
import { Redirect } from '@/components/appShell/workspace/destinationRoute';

import { useApiTokenSettingsScopeController } from '@/components/settings/apiTokens/collection/ApiTokenSettingsScope';
import { useApiTokenSettingsControllerState } from '@/components/settings/apiTokens/useApiTokenSettingsControllerState';

import { EmbedsListScreen } from './EmbedsListScreen';
import { embedDetailPath, readLastVisitedEmbed, resolveEmbedCollectionLanding } from './embedsCollection';

/**
 * `/settings/embeds`. Beside the rail an embed is always open, so the index lands on the last opened
 * or first one; where no rail shows, the index is the embeds list and each row pushes its detail.
 */
export const EmbedsSettingsIndex = React.memo(function EmbedsSettingsIndex() {
    const view = useHappierCollectionIndexView();
    if (view === 'pending') return null;
    if (view === 'land') return <EmbedCollectionLanding />;
    return <EmbedsListScreen />;
});

const EmbedCollectionLanding = React.memo(function EmbedCollectionLanding() {
    const state = useApiTokenSettingsControllerState(useApiTokenSettingsScopeController());
    // Until the first list answers there is no embed to land on and no rail beside the page, so the
    // page itself shows: its header and primary at once, with skeleton rows (lab L3). A Retry from the
    // error state comes back here too, so it never blanks the page.
    if ((state.phase === 'idle' || state.phase === 'loading') && state.tokens.length === 0) return <EmbedsListScreen />;
    const landingId = resolveEmbedCollectionLanding(state.tokens, readLastVisitedEmbed());
    if (landingId) return <Redirect href={embedDetailPath(landingId) as never} />;
    return <EmbedsListScreen />;
});
