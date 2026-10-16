import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { ExpandableItem, ExpandableItemCaret } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { isSessionAwarenessContentReadableV1 } from '@happier-dev/protocol/sessions/awareness/availability';
import { useArtifact, useProjectAccountRows, useServerScopedMachine, useSessionListRenderableWithServerScope } from '@/sync/domains/state/storage';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { projectUiSessionAwareness } from '@/sync/domains/session/awareness/sessionAwareness';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import type { ApprovalActionFieldsPresentation } from './approvalFieldValues';
import { useProviderCatalogForServer } from '@/sync/store/useProviderCatalog';
import { readAccountProviderDeclarations } from '@/providers/catalog/accountProviderDeclarations';
import { presentProviderConnectionIdentity } from '@/providers/connection/presentation';
import { areProviderContributionKeysEqualV1 } from '@happier-dev/protocol/providers/contribution-identity';
import { builtInSettingUiDeclaration } from '@/components/settings/catalog/settingDeclarations';
import { useMcpServerCatalogForServer } from '@/components/settings/mcpServers/useMcpServersSettings';
import { mcpServerDisplayName } from '@/components/settings/mcpServers/collection/mcpServerCollectionModel';
import { usePromptLibraryCatalogValue } from '@/sync/store/usePromptLibraryCatalog';
import { useAgentCatalogIdentities } from '@/agents/registry/useSessionAgentCatalogIdentity';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { BUILT_IN_REGISTRY_SOURCES_V1 } from '@happier-dev/protocol/registries';

type ApprovalFieldRow = ApprovalActionFieldsPresentation['rows'][number];
type ApprovalValueRow = Extract<ApprovalFieldRow, { kind: 'value' }>;
type ApprovalReference = NonNullable<ApprovalValueRow['reference']>;
import {
    describeUnnamedApprovalSession,
    resolveApprovalHomeName,
} from './approvalRequesterLabels';

/**
 * The arguments an approval would run with. `card` (default) is the self-contained card a transcript
 * prompt shows; `page` is the approval page's "Details" section, in the page's own section and row
 * anatomy (one row per argument: its name, then its value).
 */
export const ActionApprovalFieldsCard = React.memo(function ActionApprovalFieldsCard(props: Readonly<{
    presentation: ApprovalActionFieldsPresentation;
    anatomy?: 'card' | 'page';
    /** The approval's Home: a value that is one of its sessions (or a Home) reads by its name. */
    serverId?: string | null;
}>) {
    const allRows = props.presentation.rows;
    // People read names, choices and values; opaque ids stay present, one disclosure away.
    const rows = React.useMemo(() => allRows.filter((row) => !(row.kind === 'value' && row.technical)), [allRows]);
    const technical = React.useMemo(() => collectApprovalTechnicalLines(allRows), [allRows]);
    if (allRows.length === 0) return null;
    const serverId = props.serverId ?? null;
    const technicalDetails = technical.length > 0 ? <ApprovalTechnicalDetails lines={technical} /> : null;

    if (props.anatomy === 'page') {
        return (
            <ItemGroup title={t('approvals.details')}>
                {rows.map((row) => row.kind === 'value' && !row.entries ? (
                    <ApprovalValueItem key={row.path} row={row} serverId={props.serverId ?? null} anatomy="page" />
                ) : row.kind === 'value' && row.entries ? (
                    // A structured value is still one argument: the same row as its siblings, the
                    // argument's name as the title and its entries in the description's place.
                    <Item
                        key={row.path}
                        title={row.title}
                        subtitle={<ApprovalStructuredValue entries={row.entries} serverId={serverId} anatomy="page" />}
                        mode="info"
                        showChevron={false}
                    />
                ) : (
                    // Questions and answers, or the notice that a value cannot be shown, are content
                    // rather than one value: they sit in the section under the argument's name.
                    <SectionContentRow key={row.path}>
                        <View style={styles.row}>
                            <Text style={styles.label}>{row.title}</Text>
                            <ApprovalFieldValue row={row} />
                        </View>
                    </SectionContentRow>
                ))}
                {technicalDetails}
            </ItemGroup>
        );
    }

    return (
        <View style={styles.card}>
            <Text style={styles.sectionTitle}>{t('approvals.details')}</Text>
            <View style={styles.rows}>
                {rows.map((row) => (
                    <View key={row.path} style={styles.row}>
                        {row.kind === 'value' && !row.entries ? (
                            <ApprovalValueItem row={row} serverId={serverId} />
                        ) : (
                            <>
                                <Text style={styles.label}>{row.title}</Text>
                                <ApprovalFieldValue row={row} serverId={serverId} />
                            </>
                        )}
                    </View>
                ))}
            </View>
            {technicalDetails}
        </View>
    );
});

/**
 * One argument row. An id the person knows by name (a session, a Home) reads by that name; a session
 * this device cannot name reads by where it lives. Non-references, including Host identities,
 * keep the Protocol's literal value and structured keys.
 */
function ApprovalValueItem(props: Readonly<{
    row: Extract<ApprovalActionFieldsPresentation['rows'][number], { kind: 'value' }>;
    serverId: string | null;
    anatomy?: 'page';
}>) {
    const { row } = props;
    // A declared confidential input is held by the original request and never shown: it reads as
    // supplied under its declared title, not as a missing or unavailable value.
    const literal = row.valueFormat === 'unavailable' ? t('common.unavailable')
        : row.valueFormat === 'confidential' ? t('approvals.confidentialSupplied')
        : row.valueFormat === 'boolean' ? t(row.value === 'true' ? 'common.yes' : 'common.no') : row.value;
    const reading = useApprovalReferenceReading(row.reference, literal, props.serverId);
    const title = nameApprovalReferenceLabel(row.title, row.reference, reading.named);
    if (props.anatomy !== 'page') {
        return (
            <>
                <Text style={styles.label}>{title}</Text>
                <Text style={styles.value}>{reading.text}</Text>
            </>
        );
    }
    return (
        <Item
            title={title}
            subtitle={reading.text}
            subtitleLines={0}
            mode="info"
            showChevron={false}
        />
    );
}

/**
 * A reference reads by its name: a session by its title (or where it lives), a Home by its name, the
 * viewer's own Account as theirs. One this device cannot name keeps its exact id in place (`named`
 * false), and so keeps its id label.
 */
function useApprovalReferenceReading(reference: ApprovalReference | undefined, literal: string, approvalServerId: string | null): Readonly<{ text: string; named: boolean }> {
    const serverId = reference?.kind === 'session' ? reference.serverId ?? approvalServerId : approvalServerId;
    const name = useApprovalSessionName(serverId, reference?.kind === 'session' ? reference.id : '');
    const viewer = useAccountSettingsScope();
    const ownHome = isSameApprovalHome(viewer?.serverId, approvalServerId);
    const skill = useArtifact(reference?.kind === 'skill' && ownHome ? reference.id : '');
    const machine = useServerScopedMachine(approvalServerId, reference?.kind === 'machine' ? reference.id : '');
    const mcp = useMcpServerCatalogForServer(reference?.kind === 'mcpServer' ? approvalServerId : null, reference?.kind === 'mcpServer');
    const registries = usePromptLibraryCatalogValue('registry-sources', reference?.kind === 'registrySource' && ownHome ? viewer : null);
    const projects = useProjectAccountRows();
    const agents = useAgentCatalogIdentities({ agentIds: reference?.kind === 'agent' ? [reference.id] : [], machineId: null,
        serverId: reference?.kind === 'agent' ? approvalServerId : null });
    const providerCatalog = useProviderCatalogForServer(reference?.kind === 'providerConnection' ? approvalServerId : null);
    const declarations = readAccountProviderDeclarations();
    if (reference?.kind === 'skill') {
        const title = ownHome && skill?.header?.kind === 'prompt_bundle.v2'
            && skill.header.bundleSchemaId === 'skills.skill_md_v1' ? skill.title ?? skill.header.title : null;
        return { text: title ?? reference.id, named: Boolean(title) };
    }
    if (reference?.kind === 'machine') {
        const title = getMachineDisplayName(machine) ?? reference.id;
        return { text: reference.workspaceRoot ? `${formatPathRelativeToHome(reference.workspaceRoot)} · ${title}` : `${t('contextBar.machine')} ${title}`, named: Boolean(machine) };
    }
    if (reference?.kind === 'mcpServer') {
        const server = mcp.value?.servers.find(row => row.id === reference.id);
        return { text: server ? mcpServerDisplayName(server) : reference.id, named: Boolean(server) };
    }
    if (reference?.kind === 'registrySource') {
        const source = registries.value?.sources.find(row => row.id === reference.id)
            ?? BUILT_IN_REGISTRY_SOURCES_V1.find(row => row.id === reference.id);
        return { text: source?.title ?? reference.id, named: Boolean(source) };
    }
    if (reference?.kind === 'project') {
        const title = ownHome && projects && projects.scope.accountId === viewer?.accountId
            && isSameApprovalHome(projects.scope.serverId, approvalServerId)
            ? projects.organizations.find(row => row.key.projectKey === reference.id)?.value.label : null;
        return { text: title ?? reference.id, named: Boolean(title) };
    }
    if (reference?.kind === 'agent') {
        const title = agents.map(row => row.entry.title).join(', ');
        return { text: title || reference.id, named: Boolean(title) };
    }
    if (reference?.kind === 'setting') {
        const setting = builtInSettingUiDeclaration(reference.id);
        return { text: t(setting.titleKey), named: true };
    }
    if (reference?.kind === 'providerContribution') {
        const declaration = declarations.find(row => areProviderContributionKeysEqualV1(row.contributionKey, reference.id));
        return { text: declaration?.definition.name ?? t('common.unavailable'), named: true };
    }
    if (reference?.kind === 'providerConnection') {
        const connection = providerCatalog?.data?.connections.find(row => row.id === reference.id);
        if (connection) {
            const sourceName = connection.source.kind === 'custom' ? connection.source.template.name
                : declarations.find(row => connection.source.kind === 'contribution'
                    && areProviderContributionKeysEqualV1(row.contributionKey, connection.source.contributionKey))?.definition.name;
            return { text: presentProviderConnectionIdentity({ ...connection,
                providerName: sourceName ?? t('common.unavailable') }).title, named: true };
        }
        return { text: reference.displayName ?? t('common.unavailable'), named: true };
    }
    if (reference?.kind === 'session') return { text: name ?? describeUnnamedApprovalSession(resolveApprovalHomeName(serverId)), named: true };
    if (reference?.kind === 'home') {
        const home = resolveApprovalHomeName(reference.id)
            ?? (isSameApprovalHome(reference.id, approvalServerId) ? t('settingsAccount.thisHomeTitle') : null);
        return home === null ? { text: literal, named: false } : { text: home, named: true };
    }
    if (reference?.kind === 'account') {
        const own = viewer !== null && viewer.accountId === reference.id && isSameApprovalHome(viewer.serverId, approvalServerId);
        return own ? { text: t('accountDisplay.yours'), named: true } : { text: literal, named: false };
    }
    return { text: literal, named: false };
}

/**
 * Whether two Home ids name one Home on this device. A request may carry the Home's portable identity
 * where this device addresses it by its own profile id; the profile owner resolves both.
 */
function isSameApprovalHome(left: string | null | undefined, right: string | null | undefined): boolean {
    const a = left?.trim();
    const b = right?.trim();
    if (!a || !b) return false;
    if (a === b) return true;
    const profile = getServerProfileById(a);
    return profile !== null && profile.id === getServerProfileById(b)?.id;
}

/**
 * A key over a name names the thing, not its id: "Session id" beside a Session's title reads
 * "Session", a Home's server id reads "Home". The exact id keeps its key in Technical details.
 */
function nameApprovalReferenceLabel(label: string, reference: ApprovalReference | undefined, named: boolean): string {
    if (!reference || !named || !/\sid$/i.test(label)) return label;
    const stem = label.replace(/\s+id$/i, '');
    return reference.kind === 'home' && /^server$/i.test(stem) ? t('common.home') : stem;
}

type ApprovalStructuredEntries = NonNullable<ApprovalValueRow['entries']>;
type ApprovalTechnicalLine = Readonly<{ key: string; label: string; value: string }>;

/**
 * What the readable part leaves out, in the request's order, labelled by where it sits ("Widget surface ›
 * Server id"): the exact id behind each name shown above, schema versions and empty values.
 */
function collectApprovalTechnicalLines(rows: readonly ApprovalFieldRow[]): readonly ApprovalTechnicalLine[] {
    const lines: ApprovalTechnicalLine[] = [];
    for (const row of rows) {
        if (row.kind !== 'value') continue;
        if (row.reference) lines.push({ key: row.path, label: row.title, value: row.value });
        else if (row.technical && !row.entries && row.path !== 'v'
            && !['', '{}', '[]', 'null'].includes(row.value)) lines.push({ key: row.path, label: row.title, value: row.value });
        if (!row.entries) continue;
        const trail: string[] = [];
        row.entries.forEach((entry, index) => {
            trail.length = entry.depth;
            if (entry.value === null) { trail.push(entry.label); return; }
            // Versions and empty values do not identify the effect. Exact ids behind resolved
            // names do, so the disclosure retains only those references.
            if (entry.reference || entry.technical && entry.label !== 'V'
                && !['', '{}', '[]', 'null'].includes(entry.value)) {
                lines.push({ key: `${row.path}:${index}`, label: [row.title, ...trail, entry.label].join(' › '), value: entry.value });
            }
        });
    }
    return lines;
}

/** The readable part of a structured value: technical leaves leave, and so do groups left empty. */
function readableApprovalEntries(entries: ApprovalStructuredEntries): ApprovalStructuredEntries {
    const kept: ApprovalStructuredEntries[number][] = [];
    entries.forEach((entry, index) => {
        if (entry.value !== null) {
            if (!entry.technical) kept.push(entry);
            return;
        }
        // A group stays when any leaf below it (before the next sibling or shallower line) is readable.
        for (let next = index + 1; next < entries.length && entries[next]!.depth > entry.depth; next += 1) {
            const candidate = entries[next]!;
            if (candidate.value !== null && !candidate.technical) { kept.push(entry); return; }
        }
    });
    return kept;
}

function ApprovalTechnicalDetails(props: Readonly<{ lines: readonly ApprovalTechnicalLine[] }>) {
    const [expanded, setExpanded] = React.useState(false);
    return (
        <ExpandableItem
            testID="approvals.technical-details"
            expanded={expanded}
            onExpandedChange={setExpanded}
            showDivider={false}
            header={({ headerProps, expanded: open }) => (
                <Item
                    {...headerProps}
                    title={t('approvals.technicalDetails')}
                    showChevron={false}
                    rightElement={<ExpandableItemCaret expanded={open} />}
                />
            )}
        >
            {/* Quiet reference lines in the entries' own type: a path, then its exact value in mono. */}
            <SectionContentRow>
                <View style={styles.entries}>
                    {props.lines.map((line) => (
                        <View key={line.key} style={styles.technicalLine}>
                            <Text style={styles.pageEntryLabel}>{line.label}</Text>
                            <Text selectable style={[styles.pageEntryValue, styles.technicalValue]}>{line.value}</Text>
                        </View>
                    ))}
                </View>
            </SectionContentRow>
        </ExpandableItem>
    );
}

function ApprovalEntryLine(props: Readonly<{ entry: ApprovalStructuredEntries[number]; serverId: string | null; labelStyle: object; valueStyle: object }>) {
    const reading = useApprovalReferenceReading(props.entry.reference, props.entry.value ?? '', props.serverId);
    return (
        <>
            <Text style={props.labelStyle}>{nameApprovalReferenceLabel(props.entry.label, props.entry.reference, reading.named)}</Text>
            <Text style={props.valueStyle}>{reading.text}</Text>
        </>
    );
}

/**
 * A structured value as Protocol reads it: one labelled line per leaf, groups indented beneath their key.
 * On the page it sits in a row's description, so it takes the description's size, with the keys a step
 * quieter than their values; the card keeps its own value type.
 */
function ApprovalStructuredValue(props: Readonly<{ entries: ApprovalStructuredEntries; serverId: string | null; anatomy?: 'page' }>) {
    const page = props.anatomy === 'page';
    const entries = readableApprovalEntries(props.entries);
    if (entries.length === 0) return null;
    return (
        <View style={styles.entries}>
            {entries.map((entry, index) => (
                <View key={`${index}:${entry.label}`} style={[styles.entry, { paddingLeft: entry.depth * ENTRY_INDENT }]}>
                    {entry.value === null ? (
                        <Text style={page ? styles.pageEntryGroup : styles.entryGroup}>{entry.label}</Text>
                    ) : (
                        <ApprovalEntryLine entry={entry} serverId={props.serverId}
                            labelStyle={page ? styles.pageEntryLabel : styles.entryLabel}
                            valueStyle={page ? styles.pageEntryValue : styles.entryValue} />
                    )}
                </View>
            ))}
        </View>
    );
}

function useApprovalSessionName(serverId: string | null, value: string): string | null {
    // An unresolved approval Home must not borrow the active Home's session names.
    const candidate = serverId?.trim() ? value : '';
    const session = useSessionListRenderableWithServerScope(serverId, candidate);
    if (!candidate || !session) return null;
    // A locked session's cached name stays private, as on every other approval surface.
    const encryption = projectUiSessionAwareness(session, Date.now()).encryption;
    const readable = encryption !== 'unknown' && isSessionAwarenessContentReadableV1(encryption);
    return readable ? getSessionName(session, serverId) : null;
}

function ApprovalFieldValue(props: Readonly<{ row: ApprovalActionFieldsPresentation['rows'][number]; serverId?: string | null }>) {
    const { row } = props;
    return (
        <>
            {row.kind === 'unrepresentable' ? (
                <View testID="approvals.unrepresentable-details" style={styles.unrepresentable}>
                    <Text style={styles.unrepresentableTitle}>{t('approvals.unsafeDetailsTitle')}</Text>
                    <Text style={styles.unrepresentableBody}>{t('approvals.unsafeDetailsBody')}</Text>
                </View>
            ) : null}
            {row.kind === 'structuredAnswers' ? (
                <View style={styles.structuredAnswers}>
                    {row.answers.map((answer, index) => (
                        <View key={`${answer.question}:${index}`} style={styles.structuredAnswer}>
                            <Text style={styles.question}>{answer.question}</Text>
                            {answer.values.map((value, valueIndex) => (
                                <Text key={`${value}:${valueIndex}`} style={styles.value}>{value}</Text>
                            ))}
                        </View>
                    ))}
                </View>
            ) : null}
            {row.kind === 'value' && row.entries ? <ApprovalStructuredValue entries={row.entries} serverId={props.serverId ?? null} /> : null}

        </>
    );
}

const ENTRY_INDENT = 12;

const styles = StyleSheet.create((theme) => ({
    card: {
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.elevated,
        padding: theme.space.s16,
        gap: theme.space.s12,
    },
    sectionTitle: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.primary,
    },
    rows: {
        gap: theme.space.s10,
    },
    row: {
        gap: theme.space.s4,
    },
    label: {
        ...Typography.variant('meta', 'semiBold'),
        color: theme.colors.text.secondary,
    },
    value: {
        fontSize: 14,
        color: theme.colors.text.primary,
        lineHeight: 20,
    },
    structuredAnswers: {
        gap: theme.space.s10,
    },
    entries: {
        gap: theme.space.s4,
    },
    entry: {
        flexDirection: 'row',
        alignItems: 'baseline',
        gap: theme.space.s8,
    },
    entryGroup: {
        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.text.secondary,
    },
    entryLabel: {
        fontSize: 13,
        lineHeight: 20,
        color: theme.colors.text.secondary,
    },
    entryValue: {
        flex: 1,
        minWidth: 0,
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text.primary,
    },
    pageEntryGroup: {
        ...happierPageTextMetrics('rowDescription'),
        fontWeight: '500',
        color: theme.colors.text.secondary,
    },
    pageEntryLabel: {
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.tertiary,
    },
    pageEntryValue: {
        ...happierPageTextMetrics('rowDescription'),
        flex: 1,
        minWidth: 0,
        color: theme.colors.text.secondary,
    },
    technicalLine: {
        gap: 1,
    },
    technicalValue: {
        ...Typography.mono(),
        flex: 0,
    },
    structuredAnswer: {
        gap: theme.space.s2,
    },
    question: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.primary,
    },
    unrepresentable: {
        gap: theme.space.s2,
    },
    unrepresentableTitle: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.state.danger.foreground,
    },
    unrepresentableBody: {
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text.secondary,
    },
}));
