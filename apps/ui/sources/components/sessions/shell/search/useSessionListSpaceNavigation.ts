import * as React from 'react';

import { neighbourCollectionSpaceId } from '@/components/ui/lists/collection/collectionSpaceSwipe';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import type { SessionListViewFilterController } from './useSessionListViewFilterController';

const SELECTED_SPACE_SETTING = { anchor: 'session.list.selectedSpace' } as const;

/** Strip, menu, digit and title-swipe intents all use the captured Settings Action writer. */
export function useSessionListSpaceNavigation(controller: SessionListViewFilterController) {
    const { setSetting } = useSettingActionFeedback({ serverId: controller.spaceSettingsScope?.serverId });
    const selectSpace = React.useCallback(async (spaceId: string): Promise<boolean> => {
        if (!controller.spacesReady || !controller.spaceSettingsScope || !controller.spaces.some(space => space.id === spaceId)) return false;
        const accepted = await setSetting(SELECTED_SPACE_SETTING, { spaceId });
        if (accepted && spaceId === controller.selectedSpaceId) controller.resetFilters();
        return accepted;
    }, [controller.resetFilters, controller.selectedSpaceId, controller.spaceSettingsScope, controller.spaces, controller.spacesReady, setSetting]);
    const selectOrdinal = React.useCallback((ordinal: number): boolean => {
        if (!controller.spacesReady || !Number.isInteger(ordinal) || ordinal < 1) return false;
        const space = controller.spaces[ordinal - 1];
        if (!space) return false;
        void selectSpace(space.id);
        return true;
    }, [controller.spaces, controller.spacesReady, selectSpace]);
    const selectRelative = React.useCallback((direction: -1 | 1): boolean => {
        const spaceId = controller.spacesReady ? neighbourCollectionSpaceId(controller.spaces, controller.selectedSpaceId, direction) : null;
        if (spaceId === null) return false;
        void selectSpace(spaceId);
        return true;
    }, [controller.selectedSpaceId, controller.spaces, controller.spacesReady, selectSpace]);
    const currentController = React.useRef(controller);
    currentController.current = controller;
    const [acceptedCoordinatorTarget, setAcceptedCoordinatorTarget] = React.useState<
        Pick<SessionListViewFilterController, 'retentionScopeKey' | 'spaceSettingsScope'> | null
    >(null);
    const [filterOpenRequested, setFilterOpenRequested] = React.useState(false);
    const acknowledgeFilterOpenRequest = React.useCallback(() => setFilterOpenRequested(false), []);
    React.useEffect(() => {
        if (!controller.showCoordinatorsRequest || !controller.spacesReady) return;
        controller.acknowledgeShowCoordinatorsRequest();
        const requestedController = controller;
        void selectSpace('my-work').then(accepted => {
            const current = currentController.current;
            if (accepted && current.retentionScopeKey === requestedController.retentionScopeKey
                && areAccountSettingsScopesEqual(current.spaceSettingsScope, requestedController.spaceSettingsScope)) {
                setAcceptedCoordinatorTarget({ retentionScopeKey: requestedController.retentionScopeKey,
                    spaceSettingsScope: requestedController.spaceSettingsScope });
            }
        });
    }, [controller, selectSpace]);
    React.useEffect(() => {
        if (!acceptedCoordinatorTarget) return;
        if (controller.retentionScopeKey !== acceptedCoordinatorTarget.retentionScopeKey
            || !areAccountSettingsScopesEqual(controller.spaceSettingsScope, acceptedCoordinatorTarget.spaceSettingsScope)) {
            setAcceptedCoordinatorTarget(null);
            return;
        }
        if (!controller.spacesReady || controller.selectedSpaceId !== 'my-work') return;
        controller.updateFilters({ ...controller.contextDefaultFilters, coordinator: 'coordinator' });
        setAcceptedCoordinatorTarget(null);
        setFilterOpenRequested(true);
    }, [acceptedCoordinatorTarget, controller]);
    return React.useMemo(() => ({ selectSpace, selectOrdinal, selectRelative, filterOpenRequested, acknowledgeFilterOpenRequest }),
        [acknowledgeFilterOpenRequest, filterOpenRequested, selectOrdinal, selectRelative, selectSpace]);
}
