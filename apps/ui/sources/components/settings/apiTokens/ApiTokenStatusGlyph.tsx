import * as React from 'react';

import { CollectionStatusGlyph } from '@/components/ui/lists/collection/CollectionStatusGlyph';

import { resolveApiTokenStatusLabel, type ApiTokenRowPresentation } from './apiTokenSettingsPresentation';

/**
 * A token's or embed's expiry in a collection row's icon-only status slot: amber while it is about to expire, neutral
 * once it has. An active token is quiet. The word is the tooltip and the accessible name.
 */
export const ApiTokenStatusGlyph = React.memo(function ApiTokenStatusGlyph(props: Readonly<{
    presentation: Pick<ApiTokenRowPresentation, 'status' | 'expiresIn'>;
    testID?: string;
}>) {
    const label = resolveApiTokenStatusLabel(props.presentation);
    if (!label) return null;
    return <CollectionStatusGlyph testID={props.testID} status={props.presentation.status === 'expired' ? 'stale' : 'review'} label={label} />;
});
