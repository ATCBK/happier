import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { RoundButtonSizeScope } from '@/components/ui/buttons/RoundButton';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PagePinnedBar } from '@/components/ui/layout/PagePinnedBar';
import { ItemList } from '@/components/ui/lists/ItemList';

/**
 * The phone's Follow page (lab P2-Ap, P2-Sp): the same header, body and footer the anchored panel places,
 * the body scrolling and the actions pinned in thumb reach under it. Personal Follow and a Session's
 * sources push the same page.
 */
export function FollowEditorPage(props: Readonly<{
    title: string;
    subtitle: string;
    footer: React.ReactNode;
    children: React.ReactNode;
    footerTestID?: string;
}>) {
    return (
        <View style={styles.page}>
            <ItemList style={{ paddingTop: 0 }}>
                <PageHeader title={props.title} description={props.subtitle} />
                {props.children}
            </ItemList>
            {props.footer ? <PagePinnedBar testID={props.footerTestID}>
                <RoundButtonSizeScope size="normal" presentation="uniform">{props.footer}</RoundButtonSizeScope>
            </PagePinnedBar> : null}
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    page: { flex: 1 },
}));
