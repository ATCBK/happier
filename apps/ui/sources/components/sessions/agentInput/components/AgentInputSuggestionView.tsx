import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { InlineRepoPathLabel } from '@/components/ui/path/InlineRepoPathLabel';
import { normalizeRepoPathParts } from '@/utils/path/normalizeRepoPathParts';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';


interface FileMentionProps {
    fileName: string;
    filePath: string;
    fileType?: 'file' | 'folder';
}

export const FileMentionSuggestion = React.memo(({ fileName, filePath, fileType = 'file' }: FileMentionProps) => {
    const { name } = React.useMemo(() => {
        return normalizeRepoPathParts({ fileName, filePath });
    }, [fileName, filePath]);

    const icon = fileType === 'folder'
        ? <Icon name="folder" size={16} color={styles.iconColor.color} />
        : <FileIcon fileName={name || fileName} size={16} />;

    // Two lines like every picker row (lab P1/P2): the name with its folder, then what it is.
    return (
        <View style={styles.suggestionContainer}>
            <View style={styles.leadingIcon}>{icon}</View>
            <View style={styles.textColumn}>
                <InlineRepoPathLabel
                    fileName={fileName}
                    filePath={filePath}
                    nameSuffix={fileType === 'folder' ? '/' : undefined}
                    pathTextStyle={styles.filePathText}
                    nameTextStyle={styles.fileTitleText}
                />
                <Text style={styles.kindText} numberOfLines={1}>
                    {fileType === 'folder' ? t('composerReferences.kindFolder') : t('composerReferences.kindFile')}
                </Text>
            </View>
        </View>
    );
});

/*
 * Vendor-plugin, skill and slash-command rows used to live here as three more
 * bespoke components drawing the same icon + title + subtitle shape
 * `CommandMenuRow` already draws (SB-6 / D-17). They are gone: the registry
 * supplies the icon, label and subtitle, and the primitive renders them.
 * `renderRow` survives only for the file row, which needs
 * `InlineRepoPathLabel`'s path-aware truncation.
 *
 * `SessionMentionAgentLogo` is gone too: the `@session` picker now renders its
 * rows through the canonical machine-qualified
 * `SessionAgentCatalogIdentityIcon` (external Agents included), so this module
 * no longer draws Agent marks at all.
 */

const styles = StyleSheet.create((theme) => ({
    // The default picker row's frame (CommandMenuRow), so file rows sit level with every other kind.
    suggestionContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s8,
        gap: theme.space.s10,
    },
    leadingIcon: {
        width: 20,
        height: 20,
        alignItems: 'center',
        justifyContent: 'center',
    },
    textColumn: {
        flex: 1,
        minWidth: 0,
        gap: theme.space.s2,
    },
    kindText: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    iconColor: {
        color: theme.colors.text.secondary,
    },
    fileTitleText: {
        ...Typography.variant('label', 'regular'),
        color: theme.colors.text.primary,
    },
    filePathText: {
        flex: 1,
        minWidth: 0,
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
}));
