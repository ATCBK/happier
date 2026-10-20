import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { ExpandableItem, ExpandableItemCaret } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { TechnicalDetailsDisclosure, type TechnicalDetailsLine } from '@/components/ui/lists/TechnicalDetailsDisclosure';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { getTranslationValue, t, tLoose } from '@/text';
import type { ApprovalActionFieldsPresentation } from './approvalFieldValues';
import { presentPluginInstallApprovalRows } from './pluginInstallApprovalFacts';

type ApprovalFieldRow = ApprovalActionFieldsPresentation['rows'][number];
type ApprovalValueRow = Extract<ApprovalFieldRow, { kind: 'value' }>;
type ApprovalReference = NonNullable<ApprovalValueRow['reference']>;
import { useApprovalReferenceReading } from './approvalReferenceReading';

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
    /** The exact identity of a Home this device cannot name; its own line never says it, so it waits here. */
    homeIdentity?: string;
    /** A failure's code the page keeps behind this same disclosure, after the arguments' own lines. */
    failureCode?: string;
    /** The executor's own words for that failure, kept in the same disclosure ahead of its code. */
    failureMessage?: string;
    /** Card only: the arguments start behind their "Details" line (a phone's inline prompt keeps its decision in view). */
    collapsed?: boolean;
}>) {
    const [detailsOpen, setDetailsOpen] = React.useState(props.collapsed !== true);
    // A kind with its own human presentation reads through it; its raw structure stays in Technical details.
    const allRows = React.useMemo(() => presentPluginInstallApprovalRows(props.presentation.rows), [props.presentation.rows]);
    // People read names, choices and values; opaque ids stay present, one disclosure away.
    const rows = React.useMemo(() => allRows.filter((row) => !(row.kind === 'value' && row.technical)), [allRows]);
    const technical = React.useMemo(
        () => [...collectApprovalTechnicalLines(allRows),
            ...(props.failureMessage ? [{ key: 'failure-message', label: t('detailPages.approval.failureTitle'), value: props.failureMessage }] : []),
            ...(props.failureCode ? [{ key: 'failure-code', label: t('common.error'), value: props.failureCode }] : []),
            ...(props.homeIdentity ? [{ key: 'home-identity', label: t('common.home'), value: props.homeIdentity }] : [])],
        [allRows, props.failureCode, props.failureMessage, props.homeIdentity],
    );
    if (allRows.length === 0 && technical.length === 0) return null;
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

    const cardRows = (
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
    );
    if (props.collapsed) {
        // Inside the prompt card the arguments wait behind one quiet "Details" line, not a second card.
        return (
            <View>
                <ExpandableItem
                    testID="approvals.details-disclosure"
                    expanded={detailsOpen}
                    onExpandedChange={setDetailsOpen}
                    showDivider={false}
                    header={({ headerProps, expanded }) => (
                        <Pressable {...headerProps} style={styles.disclosureHeader}>
                            <Text style={styles.disclosureTitle}>{t('approvals.details')}</Text>
                            <ExpandableItemCaret expanded={expanded} />
                        </Pressable>
                    )}
                >
                    <View style={styles.disclosureBody}>
                        {cardRows}
                        {technicalDetails}
                    </View>
                </ExpandableItem>
            </View>
        );
    }
    // An open card reads its arguments as one inset table, label beside value (lab `b-ask C`): the card
    // already says what is asked, so the table carries no heading or border of its own.
    return (
        <View testID="approvals.fields-table" style={styles.table}>
            {rows.map((row) => (
                <View key={row.path} testID={`approvals.fields-table.row:${row.path}`}
                    style={row.kind === 'value' ? styles.tableRow : styles.tableBlock}>
                    {row.kind === 'value' && !row.entries ? (
                        <ApprovalValueItem row={row} serverId={serverId} anatomy="table" />
                    ) : row.kind === 'value' ? (
                        <>
                            <Text style={styles.tableLabel}>{row.title}</Text>
                            <View style={styles.tableValue}><ApprovalStructuredValue entries={row.entries!} serverId={serverId} /></View>
                        </>
                    ) : (
                        <>
                            <Text style={styles.label}>{row.title}</Text>
                            <ApprovalFieldValue row={row} serverId={serverId} />
                        </>
                    )}
                </View>
            ))}
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
    anatomy?: 'page' | 'table';
}>) {
    const { row } = props;
    // A declared confidential input is held by the original request and never shown: it reads as
    // supplied under its declared title, not as a missing or unavailable value.
    const literal = row.valueFormat === 'unavailable' ? t('common.unavailable')
        : row.valueFormat === 'confidential' ? t('approvals.confidentialSupplied')
        : row.valueFormat === 'boolean' ? t(row.value === 'true' ? 'common.yes' : 'common.no')
        : row.selectedOptions ? row.selectedOptions.map(option => option.labelKey && typeof getTranslationValue(option.labelKey) === 'string'
            ? tLoose(option.labelKey) : option.label).join(', ') : row.value;
    const reading = useApprovalReferenceReading(row.reference, literal, props.serverId);
    const title = nameApprovalReferenceLabel(row.title, row.reference, reading.named);
    if (props.anatomy === 'table') {
        return (
            <>
                <Text style={styles.tableLabel}>{title}</Text>
                <Text style={[styles.value, styles.tableValue]}>{reading.text}</Text>
            </>
        );
    }
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
 * A key over a name names the thing, not its id: "Session id" beside a Session's title reads
 * "Session", a Home's server id reads "Home". The exact id keeps its key in Technical details.
 */
function nameApprovalReferenceLabel(label: string, reference: ApprovalReference | undefined, named: boolean): string {
    if (!reference || !named || !/\sid$/i.test(label)) return label;
    const stem = label.replace(/\s+id$/i, '');
    return reference.kind === 'home' && /^server$/i.test(stem) ? t('common.home') : stem;
}

type ApprovalStructuredEntries = NonNullable<ApprovalValueRow['entries']>;
export type ApprovalTechnicalLine = TechnicalDetailsLine;

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

/** The approval page's Technical details: the shared disclosure, titled for approvals. */
export function ApprovalTechnicalDetails(props: Readonly<{ lines: readonly ApprovalTechnicalLine[] }>) {
    return (
        <TechnicalDetailsDisclosure
            testID="approvals.technical-details"
            title={t('approvals.technicalDetails')}
            lines={props.lines}
        />
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
/** The key column of the inset table: wide enough for the common argument names, so the values share one edge. */
const TABLE_LABEL_WIDTH_PX = 96;

const styles = StyleSheet.create((theme) => ({
    // The inset table: the card's own fill stepped in, at the radius concentric with the card's padding.
    table: {
        borderRadius: theme.borderRadius.md,
        backgroundColor: theme.colors.surface.inset,
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s8,
        gap: theme.space.s6,
    },
    tableRow: {
        flexDirection: 'row',
        alignItems: 'baseline',
        gap: theme.space.s12,
    },
    tableBlock: {
        gap: theme.space.s4,
    },
    tableLabel: {
        ...Typography.variant('meta', 'semiBold'),
        color: theme.colors.text.secondary,
        width: TABLE_LABEL_WIDTH_PX,
        flexShrink: 0,
    },
    tableValue: {
        flex: 1,
        minWidth: 0,
    },
    disclosureHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: theme.space.s4,
        minHeight: resolveMinimumInteractiveTargetSize(Platform.OS),
    },
    disclosureTitle: {
        ...Typography.variant('meta', 'semiBold'),
        color: theme.colors.text.secondary,
    },
    disclosureBody: {
        paddingTop: theme.space.s8,
        gap: theme.space.s12,
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
