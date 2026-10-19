import * as React from 'react';
import { View } from 'react-native';
import { Redirect } from '@/components/appShell/workspace/destinationRoute';

import { createAgentSettingsRoute } from '@/agents/catalog/agentSettingsRoutes';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

import { AddAgentMenu, AgentCollectionList, useAgentCollection } from './collection/AgentCollectionList';
import { resolveAgentCollectionLandingId } from './collection/agentCollectionModel';
import { readLastVisitedAgentCollectionId } from './collection/agentCollectionVisit';
import {
    resolveAgentsMachineCandidateAvailability,
    useAgentAdministrationCatalog,
    type AgentAdministrationCatalog,
} from './collection/useAgentAdministrationCatalog';
import { useHappierCollectionIndexView } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet } from 'react-native-unistyles';

/**
 * `/settings/agents`. Beside the rail an agent is always selected, so the index lands on one; where no
 * rail shows, the index is the agent list and each row pushes its detail.
 */
export const AgentSettingsIndex = React.memo(function AgentSettingsIndex() {
    const view = useHappierCollectionIndexView();
    const catalog = useAgentAdministrationCatalog();
    if (view === 'pending') return null;
    if (view === 'land') return <AgentCollectionLanding catalog={catalog} />;
    return (
        <ItemList>
            <SettingsPageHeader
                testID="settings.agents.index.header"
                description={t('settingsAgents.collection.overviewDescription')}
                // The machine chip and "+" are this page's own controls: on a phone they stay in the page,
                // so Add's menu is never a popover nested in the navigation overflow.
                actionsPlacement="page"
                actions={(
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <MachineAdministrationTargetSelector
                            selection={catalog.targetSelection}
                            presentation="chip"
                            resolveCandidateAvailability={resolveAgentsMachineCandidateAvailability}
                            testIDPrefix="settings.agents.administration.target"
                        />
                        <AddAgentMenu catalog={catalog} />
                    </View>
                )}
            />
            <AgentCollectionList variant="page" catalog={catalog} />
        </ItemList>
    );
});

const AgentCollectionLanding = React.memo(function AgentCollectionLanding(props: Readonly<{
    catalog: AgentAdministrationCatalog;
}>) {
    const { collection, detecting } = useAgentCollection(props.catalog, '');
    // Wait for the machine's answer so "first installed" is not a guess; the pane says so meanwhile.
    if (detecting) {
        return (
            <ItemList containerStyle={styles.centeredPane}>
                <SurfaceStateCard testID="settings-agents-loading" kind="loading" title={t('common.loading')} replacesContent />
            </ItemList>
        );
    }
    const landingId = resolveAgentCollectionLandingId(collection, readLastVisitedAgentCollectionId());
    const landing = landingId ? props.catalog.agentEntries.find((entry) => entry.agentId === landingId) ?? null : null;
    if (landing) return <Redirect href={createAgentSettingsRoute(landing) as never} />;
    // Nothing to select: say so in the pane (as the rail does), never leave it blank.
    return (
        <ItemList containerStyle={styles.centeredPane}>
            <SurfaceStateCard
                testID="settings-agents-empty"
                kind="empty"
                title={t('settingsAgents.notAvailable')}
                reason={t('settingsAgents.collection.overviewDescription')}
                replacesContent
            />
        </ItemList>
    );
});

const styles = StyleSheet.create({
    centeredPane: {
        flexGrow: 1,
        justifyContent: 'center',
    },
});
