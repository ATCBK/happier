import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

/**
 * The Role step of Make coordinator was held back (a writable turn owns the session's sandbox): the typed
 * explanation, and, while that turn still runs, the one deliberate way to end it. Retry is the dialog's own
 * primary button; nothing here retries or restarts on its own.
 */
export function MakeCoordinatorRoleHeld(props: Readonly<{
    title: string;
    message: string;
    turnRunning: boolean;
    /** Null when ending the turn would not clear this refusal. */
    onStopTurn: (() => void) | null;
    stopping?: boolean;
}>) {
    const { theme } = useUnistyles();
    return (
        <ItemGroup>
            <Item
                testID="make-coordinator-role-held"
                icon={<Icon name="warning-circle" size={ICON_SIZE.md} color={theme.colors.state.warning.foreground} />}
                title={props.title}
                titleLines={0}
                subtitle={props.message || undefined}
                subtitleLines={0}
                mode="info"
                showChevron={false}
                accessibilityLiveRegion="polite"
            />
            {props.turnRunning && props.onStopTurn ? (
                <Item
                    testID="make-coordinator-stop-turn"
                    icon={<Icon name="stop-circle" size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
                    title={t('sessionCoordinator.make.stopTurn')}
                    subtitle={t('sessionCoordinator.make.stopTurnDescription')}
                    subtitleLines={0}
                    loading={props.stopping === true}
                    onPress={props.onStopTurn}
                    showChevron={false}
                />
            ) : null}
        </ItemGroup>
    );
}
