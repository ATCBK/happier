import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SelectionList } from '@/components/ui/selectionList/SelectionList';
import type { SelectionListStep } from '@/components/ui/selectionList/_types';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { getServerProfileById, listServerProfiles, resolveServerProfileScopeId } from '@/sync/domains/server/serverProfiles';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { t } from '@/text';

const styles = StyleSheet.create(() => ({
    chooser: { flex: 1, width: '100%', alignSelf: 'center' },
    back: { marginVertical: 12, alignSelf: 'center' },
}));

function SessionHomeChooser(props: Readonly<{
    sessionId: string;
    candidateServerIds: readonly string[];
    descriptionKey: 'session.whichHomeDescription' | 'session.whichHomeUnknownDescription';
}>) {
    const navigateToSession = useNavigateToSession();
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const maxWidthStyle = useLayoutMaxWidthStyle();
    const profilesGeneration = useServerProfilesGeneration();
    const { theme } = useUnistyles();
    const homeMark = theme.colors.text.secondary;
    const step = React.useMemo<SelectionListStep>(() => ({
        id: 'homes',
        title: t('session.whichHomeTitle'),
        sections: [{
            kind: 'static',
            id: 'homes',
            options: props.candidateServerIds.map((serverId) => {
                const profile = getServerProfileById(serverId);
                const label = resolveHomeDisplayLabel(profile, serverId);
                const address = profile?.serverUrl;
                return {
                    id: serverId,
                    label,
                    // Each candidate is a Home the person can open: its mark, its name, then its address.
                    icon: () => <Icon name="house" size={ICON_SIZE.lg} color={homeMark} />,
                    ...(address && address !== label ? { subtitle: address } : {}),
                };
            }),
        }],
    }), [props.candidateServerIds, profilesGeneration, homeMark]);
    const backToSessions = React.useCallback(() => router.replace('/'), [router]);
    return (
        <View testID="session-home-chooser" style={[styles.chooser, maxWidthStyle, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
            <PageHeader title={t('session.whichHomeTitle')} description={t(props.descriptionKey)} testID="session-home-chooser.header" />
            <SelectionList
                rootStep={step}
                selectedOptionId={null}
                listAccessibilityLabel={t('session.whichHomeTitle')}
                fillAvailableSpace
                onSelect={(serverId) => {
                    if (props.candidateServerIds.includes(serverId)) {
                        void navigateToSession(props.sessionId, { serverId });
                    }
                }}
                onRequestClose={backToSessions}
                testID="session-home-chooser.list"
            />
            <RoundButton title={t('common.back')} display="inverted" size="normal" onPress={backToSessions} testID="session-home-chooser.back" style={styles.back} />
        </View>
    );
}

function UnknownSessionHomeChooser(props: Readonly<{ sessionId: string }>) {
    const profilesGeneration = useServerProfilesGeneration();
    const savedServerIds = React.useMemo(() => [...new Set(
        listServerProfiles().map((profile) => resolveServerProfileScopeId(profile)).filter(Boolean),
    )], [profilesGeneration]);
    if (savedServerIds.length === 0) return <SessionInvalidLinkMessage />;
    return <SessionHomeChooser sessionId={props.sessionId} candidateServerIds={savedServerIds} descriptionKey="session.whichHomeUnknownDescription" />;
}

/** A link that names no Session is a page-sized error state through the one state owner. */
function SessionInvalidLinkMessage() {
    return (
        <View testID="session-invalid-link" style={{ flex: 1 }}>
            <SurfaceStateCard kind="error" size="page" title={t('session.invalidLinkTitle')} reason={t('session.invalidLinkDescription')} />
        </View>
    );
}

/**
 * A bare Session link resolves only when its origin names the Home or exactly one
 * known Session address matches (Lane 07.1). Several known candidates ask which of
 * them; a link no Home is known to hold (`homeChoice: 'unknown'`) is never answered
 * by the focused Home — the person chooses which saved Home to open it on, with no
 * preselection, and that choice opens the exact qualified route.
 */
export function SessionInvalidLinkFallback(props: Readonly<{
    sessionId?: string;
    candidateServerIds?: readonly string[];
    homeChoice?: 'unknown';
}> = {}) {
    if (props.sessionId && props.candidateServerIds && props.candidateServerIds.length > 1) {
        return <SessionHomeChooser sessionId={props.sessionId} candidateServerIds={props.candidateServerIds} descriptionKey="session.whichHomeDescription" />;
    }
    if (props.sessionId && props.homeChoice === 'unknown') {
        return <UnknownSessionHomeChooser sessionId={props.sessionId} />;
    }
    return <SessionInvalidLinkMessage />;
}
