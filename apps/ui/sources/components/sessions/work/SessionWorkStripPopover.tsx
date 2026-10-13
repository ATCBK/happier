import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { useSessionViewShellSession } from '@/components/sessions/shell/sessionViewStableSession';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { useSessionWorkSources } from './sessionWorkSources';
import { SessionWorkMapView } from './SessionWorkMapView';
import { useSessionWorkMap } from './useSessionWorkMap';

/**
 * The strip's popover (lab `session-C`): the lead's work as a map, with "3 still working · 1 needs you"
 * as its line and "Open in sidebar" to keep it open as the Work tab. It is the open leaf: only while it
 * shows does anything read the rows behind the strip's counts.
 */

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        width: 420,
        maxWidth: '100%',
        padding: theme.space.s12,
        gap: theme.space.s10,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    title: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.primary,
    },
    line: {
        ...Typography.tabular(),
        flex: 1,
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    openLink: {
        ...Typography.variant('meta', 'semiBold'),
        color: theme.colors.text.link,
    },
}));

export const SessionWorkStripPopoverContent = React.memo((props: Readonly<{
    sessionId: string;
    serverId: string | null;
    scopeId: string;
    line: string;
    onOpenInSidebar: () => void;
    onClose: () => void;
}>) => {
    const styles = stylesheet;
    const sources = useSessionWorkSources();
    const session = useSessionViewShellSession(props.sessionId, props.serverId);
    const projection = sources?.projection ?? null;
    const { map, openItem } = useSessionWorkMap({
        sessionId: props.sessionId,
        serverId: props.serverId,
        scopeId: props.scopeId,
        subagents: sources?.agentActivity.subagents ?? [],
        session,
        projection,
    });
    const { onClose } = props;
    const openAndClose = React.useCallback((item: Parameters<typeof openItem>[0]) => {
        onClose();
        openItem(item);
    }, [onClose, openItem]);

    return (
        <View testID="session-work-strip-popover" style={styles.root}>
            <View style={styles.header}>
                <Text accessibilityRole="header" style={styles.title}>{t('sessionWork.title')}</Text>
                <Text numberOfLines={1} style={styles.line}>{props.line}</Text>
                <HappierPressable
                    testID="session-work-strip-open-sidebar"
                    accessibilityRole="button"
                    accessibilityLabel={t('sessionWork.strip.openInSidebar')}
                    onPress={props.onOpenInSidebar}
                >
                    <Text style={styles.openLink}>{t('sessionWork.strip.openInSidebar')}</Text>
                </HappierPressable>
            </View>
            {map && projection ? (
                <SessionWorkMapView map={map} projection={projection} testIDPrefix="session-work-strip-map" onOpenItem={openAndClose} />
            ) : null}
        </View>
    );
});
