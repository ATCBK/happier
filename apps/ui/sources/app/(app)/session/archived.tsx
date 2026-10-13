import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useIsFocused } from '@/components/appShell/workspace/destinationRoute';

import { SessionsList } from '@/components/sessions/shell/SessionsList';
import { resolveFocusedSessionListSurfaceOwnership } from '@/components/sessions/shell/surface/sessionListSurfaceOwnership';
import { useDestinationPageTitle } from '@/components/appShell/workspace/DestinationInstanceHost';
import { t } from '@/text';

const stylesheet = StyleSheet.create(() => ({
    root: {
        flex: 1,
    },
}));

const ARCHIVED_SESSIONS_PATHNAME = '/session/archived';

/**
 * Thin deep-link/Back host for the archived Session corpus.
 *
 * Rows, search, pagination, coverage/empty/error states, archive and unarchive
 * actions and navigation all belong to the canonical Sessions list; this route only
 * selects the archived corpus and binds the surface to its own focus. It owns no
 * cursor, request lifecycle, grouping or row presentation of its own.
 */
export function ArchivedSessionsScreen() {
    useDestinationPageTitle(t('sessionInfo.archivedSessions'));
    const isFocused = useIsFocused();
    const surfaceOwnership = resolveFocusedSessionListSurfaceOwnership(isFocused);
    const styles = stylesheet;

    return (
        <View style={styles.root} testID="archived-sessions-screen">
            <SessionsList
                corpusStorage="archived"
                pathname={ARCHIVED_SESSIONS_PATHNAME}
                releaseRetentionOnRouteRemoval
                surfaceOwnership={surfaceOwnership}
            />
        </View>
    );
}

export { ArchivedSessionsScreen as WorkspaceRouteBody };

export default function RouteEntry() { return <WorkspaceRouteEntry Body={ArchivedSessionsScreen} />; }
