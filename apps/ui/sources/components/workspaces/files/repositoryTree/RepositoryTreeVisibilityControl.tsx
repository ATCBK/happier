import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

export function RepositoryTreeVisibilityControl(props: Readonly<{
    mode: 'project' | 'all'; available?: boolean; onChange: (mode: 'project' | 'all') => void;
}>) {
    const { theme } = useUnistyles();
    return <View style={{ paddingHorizontal: theme.space.s12, paddingBottom: theme.space.s8, gap: theme.space.s6 }}>
        <SegmentedTabBar tabs={[
            { id: 'project', label: t('files.toolbar.projectFiles'), disabled: props.available === false },
            { id: 'all', label: t('files.toolbar.allFiles') },
        ]} activeTabId={props.available === true ? props.mode : 'all'} onSelectTab={props.onChange} testIDPrefix="repository-tree-visibility" />
        {props.available === false ? <Text testID="repository-tree-project-unavailable" style={{ color: theme.colors.text.secondary }}>
            {t('files.toolbar.projectFilesUnavailable')}
        </Text> : null}
    </View>;
}
