import * as React from 'react';
import { getBuiltinWorkflowCatalogV1, type BuiltinWorkflowCatalogEntryV1 } from '@happier-dev/protocol/workflows/builtins/catalog';
import { countWorkflowStepsV1 } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { useViewportClass } from '@/utils/platform/useViewportClass';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { openSessionGoalControl } from '@/components/sessions/workState/openSessionGoalControl';
import { resolveSessionRoutePathForSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { createWorkflowDefinitionRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { t, tLoose } from '@/text';
import { useWorkflowExistingSessionOptions } from '../screens/useWorkflowExistingSessionOptions';
import { WorkflowPurposeGlyph } from '../presentation/WorkflowPurposeGlyph';
import { useWorkflowAccountLifetime } from '../workflowAccountScope';

/**
 * Built-in rows are projections of Protocol's catalog, never Account library records. Each is a quiet
 * destination row (lab `nav-N1`): mark, name, what it does, its size as the value, and the chevron. Run now and
 * Choose a session… live on the built-in's own page, so the section carries no action per row.
 */
export function WorkflowBuiltinsSection(): React.ReactElement {
    const entries = getBuiltinWorkflowCatalogV1();
    return <ItemGroup title={t('workflows.page.blocks.builtin')} description={t('workflows.examples.builtInDescription')}>
        {entries.map((entry) => <BuiltinRow key={entry.id} entry={entry} />)}
    </ItemGroup>;
}

function BuiltinRow({ entry, showDivider }: Readonly<{ entry: BuiltinWorkflowCatalogEntryV1; showDivider?: boolean }>) {
    const router = useRouter();
    // "{n} steps" and the description only (04 §3.3, F15): a built-in's runs carry no library key for a strip.
    const count = t('workflows.examples.stepCount', { count: countWorkflowStepsV1(entry.definition.blocks) });
    // A phone keeps the description's full width beside the chevron (only a chevron sits right of a label there);
    // the size is on the built-in's own page.
    const phone = useViewportClass() === 'compact';
    return <Item testID={`workflow-builtins:${entry.id}`} title={tLoose(entry.titleKey)} subtitle={tLoose(entry.descriptionKey)} detail={phone ? undefined : count}
        detailTestID={`workflow-builtins:${entry.id}:count`} showDivider={showDivider} showChevron
        icon={<WorkflowPurposeGlyph purpose={entry.purpose} />}
        onPress={() => router.push(createWorkflowDefinitionRoute(entry.id) as never)} />;
}

/** Uses the same Session candidacy and Home identity as continuation and trigger pickers. */
export function WorkflowBuiltinSessionButton(props: Readonly<{ entry: BuiltinWorkflowCatalogEntryV1; testID?: string; primary?: boolean }>) {
    const router = useRouter();
    const focusedScope = useActiveServerAccountScope();
    const accountLifetime = useWorkflowAccountLifetime();
    const scope = accountLifetime === undefined ? focusedScope : accountLifetime?.scope;
    const [open, setOpen] = React.useState(false);
    const { existingSessions } = useWorkflowExistingSessionOptions({ serverId: scope?.serverId ?? null, machineId: null, enabled: open });
    return <DropdownMenu open={open} onOpenChange={setOpen} search
        items={(scope === null ? [] : existingSessions).map((session) => ({ id: session.sessionId, title: session.label }))}
        trigger={({ toggle }) => <RoundButton testID={props.testID} size="small" display={props.primary ? 'default' : 'secondary'} title={t('workflows.examples.chooseSession')} onPress={toggle} />}
        selectedId={null}
        onSelect={(sessionId) => {
            if (!scope || accountLifetime === null || accountLifetime && !accountLifetime.isCurrent()
                || !existingSessions.some((session) => session.sessionId === sessionId)) return;
            setOpen(false);
            if (props.entry.id === 'builtin:keep-going') {
                openSessionGoalControl({ serverId: scope.serverId, sessionId });
                router.push(resolveSessionRoutePathForSurface(sessionId, 'chat', { serverId: scope.serverId }) as never);
            } else {
                router.push({ pathname: '/session/[id]/triggers', params: { id: sessionId, serverId: scope.serverId } } as never);
            }
        }} />;
}
