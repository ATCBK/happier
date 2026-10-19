import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { buildMachineAgentInventoryKey } from '@happier-dev/protocol/capabilities';

import type { MachineAgent } from '@/agents/machineAgents/machineAgentTypes';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { CardGrid } from '@/components/ui/cardGrid/CardGrid';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon } from '@/components/ui/icons/Icon';
import { SetupBlockPaper } from '@/components/ui/setupBlocks/SetupBlockPaper';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { rankFirstAgentChoices } from './machineAgentPresentation';


function describeChoice(agent: MachineAgent): string {
    const service = agent.signIn.connectedServices.find((candidate) => candidate.connected && candidate.healthy)
        ?? agent.signIn.connectedServices[0];
    if (service?.connected && service.profileLabel) return t('machineAgents.choiceUsesService', { service: service.title, profile: service.profileLabel });
    if (service) return t('machineAgents.useService', { service: service.title });
    return t('machineAgents.choiceSignsInOn');
}

/**
 * Home's "Set up your first agent" (lab H1, user ruling 2026-09-30: no tint on the outer block — only
 * the inner cards carry fill and border). Shown only while the composer's machine has no agent. A choice
 * grows into the compact setup form in place (H1f); the form is the caller's (`renderForm`).
 */
export const FirstAgentSetupBlock = React.memo(function FirstAgentSetupBlock(props: Readonly<{
    machineName: string;
    agents: readonly MachineAgent[];
    phone: boolean;
    renderMark: (agent: MachineAgent) => React.ReactNode;
    renderForm: (agent: MachineAgent) => React.ReactNode;
    onAllAgents: () => void;
    onDismiss: () => void;
    testID: string;
}>) {
    const { theme } = useUnistyles();
    const [chosenId, setChosenId] = React.useState<string | null>(null);
    const chosen = chosenId ? props.agents.find((agent) => buildMachineAgentInventoryKey(agent) === chosenId) ?? null : null;
    const { choices, more } = rankFirstAgentChoices(props.agents);
    return (
        <View testID={props.testID} style={styles.block}>
            <View style={styles.head}>
                <Icon name={props.phone ? 'desktop' : 'laptop'} size={24} color={theme.colors.text.secondary} />
                <View style={styles.headText}>
                    <Text style={styles.title}>{chosen ? t('machineAgents.setupTitle', { agent: chosen.title }) : t('machineAgents.firstTitle')}</Text>
                    <Text style={styles.lead}>{chosen ? t('machineAgents.onMachine', { machine: props.machineName }) : t('machineAgents.firstLead', { machine: props.machineName })}</Text>
                </View>
                {chosen ? (
                    <IconButton testID={`${props.testID}.back`} iconName="arrow-left" variant="plain" size={28} iconSize={15} accessibilityLabel={t('machineAgents.allAgents')} onPress={() => setChosenId(null)} />
                ) : null}
                <IconButton
                    testID={`${props.testID}.dismiss`}
                    iconName="x"
                    variant="plain"
                    size={28}
                    iconSize={14}
                    accessibilityLabel={t('machineAgents.dismissFirst')}
                    tooltip={t('machineAgents.dismissTooltip')}
                    onPress={props.onDismiss}
                />
            </View>
            {chosen ? (
                <SetupBlockPaper testID={`${props.testID}.form`} layout="row">
                    <View style={styles.formBody}>{props.renderForm(chosen)}</View>
                </SetupBlockPaper>
            ) : (
                <>
                    <CardGrid testID={`${props.testID}.choices`} columns={props.phone ? 1 : 3}>
                        {choices.map((agent, index) => (
                            <SetupBlockPaper key={buildMachineAgentInventoryKey(agent)} testID={`${props.testID}.choice.${buildMachineAgentInventoryKey(agent)}`} layout={props.phone ? 'row' : 'card'}>
                                <View style={props.phone ? styles.choiceRowMark : styles.choiceMark}>{props.renderMark(agent)}</View>
                                <View style={props.phone ? styles.choiceRowText : null}>
                                    <Text style={styles.choiceTitle}>{agent.title}</Text>
                                    <Text style={[styles.choiceText, props.phone ? null : styles.choiceTextCard]}>{describeChoice(agent)}</Text>
                                </View>
                                <View style={props.phone ? null : styles.choiceFoot}>
                                    <RoundButton
                                        testID={`${props.testID}.choice.${buildMachineAgentInventoryKey(agent)}.setUp`}
                                        size="small"
                                        display={index === 0 ? 'default' : 'secondary'}
                                        title={t('machineAgents.setUp')}
                                        onPress={() => setChosenId(buildMachineAgentInventoryKey(agent))}
                                    />
                                </View>
                            </SetupBlockPaper>
                        ))}
                    </CardGrid>
                    <View style={styles.more}>
                        {more > 0 ? <Text style={styles.lead}>{t('machineAgents.firstMore', { count: more })}</Text> : null}
                        <View style={styles.grow} />
                        <RoundButton testID={`${props.testID}.allAgents`} size="small" display="inverted" title={t('machineAgents.allAgents')} onPress={props.onAllAgents} />
                    </View>
                </>
            )}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    // No paper, tint or glow: the block is the page (user ruling 2026-09-30); its cards carry the paper.
    block: {
        gap: 14,
    },
    head: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s12,
    },
    headText: {
        flex: 1,
        minWidth: 0,
    },
    title: {
        ...Typography.variant('heading'),
        color: theme.colors.text.primary,
    },
    lead: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.secondary,
    },
    choiceMark: {
        height: 24,
        justifyContent: 'center',
    },
    choiceRowMark: {
        width: 24,
        alignItems: 'center',
    },
    choiceRowText: {
        flex: 1,
        minWidth: 0,
    },
    choiceTitle: {
        ...Typography.default('semiBold'),
        ...happierPageTextMetrics('rowTitle'),
        color: theme.colors.text.primary,
    },
    choiceText: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        marginTop: theme.space.s2,
        color: theme.colors.text.secondary,
    },
    choiceTextCard: {
        minHeight: 36,
    },
    choiceFoot: {
        marginTop: 'auto',
        flexDirection: 'row',
    },
    formBody: {
        flex: 1,
        paddingVertical: theme.space.s4,
    },
    more: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    grow: {
        flexGrow: 1,
    },
}));
