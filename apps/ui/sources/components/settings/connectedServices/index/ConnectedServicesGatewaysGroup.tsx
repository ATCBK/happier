import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import type { ConnectedServicesGatewayRow } from '../model/useConnectedServicesIndex';

/**
 * Gateways on the Connected services index (lab `rgateway` GW1p): the phone's way in, since the rail
 * that lists them on wide screens is not shown there. Each opens the gateway's one page. With none
 * yet, one quiet row adds the first (D19); while that waits on an approval, the approval takes the
 * row's place, where the user asked for it.
 */
export const ConnectedServicesGatewaysGroup = React.memo(function ConnectedServicesGatewaysGroup(props: Readonly<{
    gateways: readonly ConnectedServicesGatewayRow[];
    /** The Account catalog is still loading: one quiet row keeps the group's place. */
    loading?: boolean;
    onOpen: (gateway: ConnectedServicesGatewayRow) => void;
    onAdd?: () => void;
    adding?: boolean;
    addError?: string | null;
    approval?: React.ReactNode;
}>) {
    const { theme } = useUnistyles();
    if (props.gateways.length === 0 && !props.onAdd && !props.approval && !props.loading) return null;
    return (
        <ItemGroup title={t('settingsProvidersCollection.gateway.railGroup')}>
            {props.approval ?? null}
            {props.loading && props.gateways.length === 0 && !props.approval ? (
                <Item
                    testID="connected-services-index:gateways-loading"
                    title={t('common.loading')}
                    titleStyle={{ color: theme.colors.text.tertiary }}
                    icon={<Icon name="path" size={18} color={theme.colors.text.tertiary} />}
                    showChevron={false}
                    disabled
                />
            ) : null}
            {props.gateways.length === 0 && props.onAdd && !props.approval ? (
                <Item
                    testID="connected-services-index:add-gateway"
                    title={t('settingsProvidersCollection.gateway.addGateway')}
                    titleStyle={{ color: theme.colors.text.secondary }}
                    subtitle={props.addError ?? undefined}
                    subtitleStyle={props.addError ? { color: theme.colors.state.danger.foreground } : undefined}
                    icon={<Icon name="plus" size={18} color={theme.colors.text.secondary} />}
                    showChevron={false}
                    loading={props.adding}
                    disabled={props.adding}
                    onPress={props.onAdd}
                />
            ) : null}
            {props.gateways.map((gateway) => (
                <Item
                    key={gateway.connectionId}
                    testID={`connected-services-index:gateway:${gateway.connectionId}`}
                    title={gateway.title}
                    subtitle={gateway.summary}
                    icon={<Icon name="path" size={18} color={theme.colors.text.secondary} />}
                    onPress={() => props.onOpen(gateway)}
                />
            ))}
        </ItemGroup>
    );
});
