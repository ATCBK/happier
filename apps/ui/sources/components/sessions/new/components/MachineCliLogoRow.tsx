import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { AgentId } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { getAgentPickerIconScale } from '@/agents/registry/registryUi';
import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';

import { resolveMachineCliLogoDisplay } from './machineCliLogoDisplay';

// Small, monochrome provider marks — recognizable at a glance without widening the row.
const CLI_LOGO_SIZE = 16;

/**
 * The agents found on a machine as a row of their marks, capped with a "+N": the one presentation
 * of a machine's agent readiness, on machine rows, in the machine picker and on the hubs.
 */
export const MachineCliLogoRow = React.memo(function MachineCliLogoRow(props: Readonly<{
    agentIds: ReadonlyArray<AgentId>;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const display = React.useMemo(() => resolveMachineCliLogoDisplay(props.agentIds), [props.agentIds]);
    return (
        <View testID={props.testID} style={stylesheet.row}>
            {display.visible.map((agentId) => (
                <View key={agentId} style={stylesheet.logoSlot}>
                    <AgentIcon
                        agentId={agentId}
                        size={CLI_LOGO_SIZE}
                        color={theme.colors.text.secondary}
                        style={{ transform: [{ scale: getAgentPickerIconScale(agentId) }] }}
                        testID={`machine-cli-logo:${agentId}`}
                    />
                </View>
            ))}
            {display.overflow > 0 ? (
                <Text style={stylesheet.overflow}>{`+${display.overflow}`}</Text>
            ) : null}
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
    },
    logoSlot: {
        width: CLI_LOGO_SIZE,
        height: CLI_LOGO_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
    },
    overflow: {
        color: theme.colors.text.secondary,
        ...Typography.variant('micro', 'semiBold'),
    },
}));
