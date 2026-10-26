import * as React from 'react';
import {
    resolveCollectionSpacesV1, resolveCollectionSpaceSelectionV1,
    type CollectionEntityKindV1, type CollectionSpacesV1,
} from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import type { CollectionFilterMapV1 } from '@happier-dev/protocol/collections/filter/entityListFilterV1';
import { useAccountSettingsScope, useActiveServerAccountScope, useLocalSetting, useSetting, useSettingsReady } from '@/sync/domains/state/storage';
import { accountSettingsScopeKeySuffix, areAccountSettingsScopesEqual, type AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';

const EMPTY_COLLECTION_SPACES: CollectionSpacesV1 = { v: 1, spaces: [] };

/** One projection of the existing Account catalog and device selection; the entity retains its own draft. */
export function useCollectionSpaceBinding<K extends CollectionEntityKindV1>(entityKind: K, input: Readonly<{
    scope?: AccountSettingsScope | null;
    defaultName: string;
    defaultFilter: CollectionFilterMapV1[K];
}>) {
    const activeScope = useActiveServerAccountScope();
    const spaceSettingsScope = input.scope === undefined ? activeScope : input.scope;
    const settingsScope = useAccountSettingsScope();
    const settingsReady = useSettingsReady();
    const storedSpaces = useSetting('collectionSpacesV1');
    const selection = useLocalSetting('collectionSpaceV1');
    const spacesReady = spaceSettingsScope !== null && areAccountSettingsScopesEqual(spaceSettingsScope, settingsScope) && settingsReady;
    const spaceAccountScopeKey = spaceSettingsScope ? accountSettingsScopeKeySuffix(spaceSettingsScope) : '';
    const admittedSpaces = spacesReady ? storedSpaces : EMPTY_COLLECTION_SPACES;
    const spaces = React.useMemo(() => resolveCollectionSpacesV1(admittedSpaces, entityKind, {
        name: input.defaultName, filter: input.defaultFilter,
    }), [admittedSpaces, entityKind, input.defaultFilter, input.defaultName]);
    const selectedSpaceId = resolveCollectionSpaceSelectionV1(selection, spaceAccountScopeKey, entityKind, spaces, { authoritative: spacesReady });
    const selectedSpace = spaces.find(space => space.id === selectedSpaceId) ?? null;
    const savedSpace = React.useMemo(() => spacesReady && spaceSettingsScope && selectedSpace ? {
        accountScopeKey: spaceAccountScopeKey, id: selectedSpace.id, filter: selectedSpace.filter,
    } : undefined, [selectedSpace, spaceAccountScopeKey, spaceSettingsScope, spacesReady]);
    return { spaces, selectedSpaceId, selectedSpace, spacesReady, spaceSettingsScope, spaceAccountScopeKey, admittedSpaces, savedSpace };
}
