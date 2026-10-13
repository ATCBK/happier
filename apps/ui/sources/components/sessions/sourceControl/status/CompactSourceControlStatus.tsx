import React from 'react';
import { View } from 'react-native';
import { useSessionProjectScmSnapshot } from '@/sync/domains/state/storage';
import { StyleSheet } from 'react-native-unistyles';
import { buildSessionScmSummary } from './statusSummary';
import { Text } from '@/components/ui/text/Text';
import { Icon } from '@/components/ui/icons/Icon';

const LINE_ADDED_PREFIX = '+';
const LINE_REMOVED_PREFIX = '-';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.surface.elevated,
        paddingHorizontal: theme.space.s6,
        height: 16,
        borderRadius: 4,
    },
    fileCountText: {
        fontSize: 10,
        fontWeight: '500',
        color: theme.colors.text.secondary,
    },
    lineChanges: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s2,
    },
    addedText: {
        fontSize: 10,
        fontWeight: '600',
        color: theme.colors.versionControl.added.foreground,
    },
    removedText: {
        fontSize: 10,
        fontWeight: '600',
        color: theme.colors.versionControl.removed.foreground,
    },
}));

interface CompactSourceControlStatusProps {
    sessionId: string;
}

export function CompactSourceControlStatus({ sessionId }: CompactSourceControlStatusProps) {
    const styles = stylesheet;
    const snapshot = useSessionProjectScmSnapshot(sessionId);
    const scmStatusSummary = buildSessionScmSummary(snapshot);

    if (!scmStatusSummary || !scmStatusSummary.hasAnyChanges) {
        return null;
    }

    const hasLineChanges = scmStatusSummary.isComplete !== false && scmStatusSummary.hasLineChanges;
    const changedFilesLabel = `${scmStatusSummary.changedFiles}`;

    return (
        <View style={styles.container}>
            <Icon
                name="git-branch"
                size={10}
                color={styles.fileCountText.color}
                style={{ marginRight: 2 }}
            />
            {!hasLineChanges && (
                <Text style={styles.fileCountText}>{changedFilesLabel}</Text>
            )}
            {hasLineChanges && (
                <View style={styles.lineChanges}>
                    {scmStatusSummary.linesAdded > 0 && (
                        <Text style={styles.addedText}>
                            {`${LINE_ADDED_PREFIX}${scmStatusSummary.linesAdded}`}
                        </Text>
                    )}
                    {scmStatusSummary.linesRemoved > 0 && (
                        <Text style={styles.removedText}>
                            {`${LINE_REMOVED_PREFIX}${scmStatusSummary.linesRemoved}`}
                        </Text>
                    )}
                </View>
            )}
        </View>
    );
}
