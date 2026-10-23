import * as React from 'react';

import { isExpoPushNotificationChannelEnabled } from '@happier-dev/protocol/account/settings/accountSettings';

import { useIsDataReady, useSetting } from '@/sync/domains/state/storage';
import { getStorage } from '@/sync/domains/state/storageStore';
import { sync } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { isPushNotificationRuntimeSupported } from './pushNotificationAccess';
import { runPushNotificationPermissionPriming } from './pushNotificationPermissionPriming';

/**
 * Asks once, with in-app framing, for notification permission.
 *
 * Push-token registration deliberately never prompts, so without this an install whose OS
 * permission was never requested would silently never receive notifications. The priming decision
 * itself is gated (account setting, OS state, and a device-local record of an earlier decline), so
 * this mounts unconditionally inside the authenticated shell and stays inert in every other case.
 */
export function PushNotificationPermissionPrimingRuntime(): React.ReactElement | null {
    const attentionDeliveryPolicyV1 = useSetting('attentionDeliveryPolicyV1');
    const isDataReady = useIsDataReady();
    const hasSettingsSnapshot = getStorage()((state) => state.settingsVersion !== null);
    const pushEnabled = React.useMemo(
        () => isExpoPushNotificationChannelEnabled({ attentionDeliveryPolicyV1 }),
        [attentionDeliveryPolicyV1],
    );
    const hasRunRef = React.useRef(false);

    React.useEffect(() => {
        if (hasRunRef.current) return;
        if (!isPushNotificationRuntimeSupported()) return;
        // Shell readiness can follow a failed Settings attempt; wait for the Account's known
        // snapshot too. Consume this startup attempt even when push is off: a later Enable owns
        // its explicit permission Action and must not also trigger this automatic prompt.
        if (!isDataReady || !hasSettingsSnapshot) return;
        hasRunRef.current = true;
        if (!pushEnabled) return;

        fireAndForget(
            runPushNotificationPermissionPriming({
                pushEnabled: true,
                trigger: 'automatic',
                onGranted: () => sync.onPushPermissionGranted(),
            }),
            { tag: 'PushNotificationPermissionPrimingRuntime.run' },
        );
    }, [hasSettingsSnapshot, isDataReady, pushEnabled]);

    return null;
}
