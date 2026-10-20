import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { EmptyState } from '@/components/ui/empty/EmptyState';
import { t } from '@/text';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { useSessionListNavigationActions } from './useSessionListNavigationActions';

const stylesheet = StyleSheet.create(() => ({
    root: {
        width: '100%',
        paddingTop: 8,
    },
}));

/**
 * Every Session in view is inactive and inactive Sessions are hidden: one quiet line in the list
 * ("No active sessions right now") with the two ways forward as inline links. Inactive Sessions
 * live in the active corpus behind the canonical `hideInactiveSessions` preference; the archived
 * destination hosts the archived corpus. Offer both rather than sending the user to a destination
 * that cannot contain what they are looking for.
 */
export function HiddenInactiveSessionsEmptyState() {
    const styles = stylesheet;
    const { handleOpenArchivedSessions } = useSessionListNavigationActions();
    const [, setHideInactiveSessions] = useSettingMutable('hideInactiveSessions');
    const handleShowInactiveSessions = React.useCallback(() => {
        setHideInactiveSessions(false);
    }, [setHideInactiveSessions]);
    const showLabel = t('sessionsList.showInactiveSessions');
    const archivedLabel = t('sessionsList.filtersArchived');

    return (
        <View testID="sessions-hidden-inactive-empty-state" style={styles.root}>
            <EmptyState
                layout="line"
                titleTestID="sessions-hidden-inactive-empty-state-title"
                title={t('settingsFeatures.hiddenInactiveSessionsEmptyStateTitle')}
                primaryAction={{
                    label: showLabel,
                    onPress: handleShowInactiveSessions,
                    testID: 'sessions-hidden-inactive-empty-state-show-inactive',
                }}
                secondaryAction={{
                    label: archivedLabel,
                    onPress: handleOpenArchivedSessions,
                    testID: 'sessions-hidden-inactive-empty-state-open-archived',
                }}
            />
        </View>
    );
}
