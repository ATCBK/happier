import * as React from 'react';
import { getWidgetSizeFootprintV1 } from '@happier-dev/protocol/widgets';

import { CardGrid, CardGridCell } from '@/components/ui/cardGrid/CardGrid';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { PageColumnProvider } from '@/components/ui/lists/listPresentation';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';

import { isHomeHubCardSection, type HomeHubSection } from './layout/homeHubLayout';

/** Widgets and card-like sections sit two to a row (one on a phone). */
export const HOME_HUB_CARD_ROW_COLUMNS = 2;

type Placed = Readonly<{ section: HomeHubSection<WidgetCandidate>; index: number }>;

type Slot =
    | Readonly<{ kind: 'single'; key: string; entry: Placed }>
    /** Consecutive cards (widgets, Latest runs) share one row container, two across. */
    | Readonly<{ kind: 'cards'; key: string; entries: readonly Placed[] }>;

/**
 * The visible sections in order, consecutive cards grouped into rows. Every other section is its own
 * slot keyed by its id. A card run belongs to the preceding non-card boundary (even when hidden), independently of
 * which cards are visible or first, so edits within a run preserve its unaffected children.
 */
function buildSlots(sections: readonly HomeHubSection<WidgetCandidate>[]): Slot[] {
    const slots: Slot[] = [];
    let run: Placed[] = [];
    let runKey = 'cards:root';
    const flush = () => {
        if (run.length > 0) slots.push({ kind: 'cards', key: runKey, entries: run });
        run = [];
    };
    sections.forEach((section, index) => {
        if (isHomeHubCardSection(section)) {
            if (!section.hidden) run.push({ section, index });
            return;
        }
        flush();
        if (!section.hidden) slots.push({ kind: 'single', key: section.id, entry: { section, index } });
        runKey = `cards:after:${section.id}`;
    });
    flush();
    return slots;
}

/** A full-width widget, or a full-width group, takes the whole row. */
function spansRow(section: HomeHubSection<WidgetCandidate>): boolean {
    if (section.kind === 'group') return section.group.width === 'full';
    return section.kind === 'widget' && getWidgetSizeFootprintV1('home', section.size)?.columnSpan === HOME_HUB_CARD_ROW_COLUMNS;
}

/**
 * Which cards of a two-up run take the whole row: a full-width card, and any half that would otherwise
 * sit beside an empty slot (no half follows it in its row). Saved sizes are untouched; this is placement.
 */
function rowSpanningCards(entries: readonly Placed[]): ReadonlySet<string> {
    const spanning = new Set<string>();
    let column = 0;
    entries.forEach((entry, index) => {
        if (spansRow(entry.section)) { spanning.add(entry.section.id); column = 0; return; }
        if (column === 1) { column = 0; return; }
        const next = entries[index + 1];
        if (!next || spansRow(next.section)) { spanning.add(entry.section.id); return; }
        column = 1;
    });
    return spanning;
}

/** What a section is told about where it landed. */
export type HomeHubSectionPlacement = Readonly<{
    /**
     * The card has its whole row to itself in a two-up grid, though it was saved at a half-row size. It
     * presents at its full-row size (lab rw-V: a Small left alone reads as its Wide) instead of stretching.
     */
    ownsRow: boolean;
}>;

type RenderSection = (section: HomeHubSection<WidgetCandidate>, index: number, placement: HomeHubSectionPlacement) => React.ReactNode;

/**
 * One row container of cards. It reads how many columns the grid resolved, so a card placed alone in its row
 * is told it owns the row only where the row really is two-up (on a phone every card already does).
 */
function CardRow(props: Readonly<{ slot: Extract<Slot, { kind: 'cards' }>; renderSection: RenderSection }>) {
    const { slot, renderSection } = props;
    const [columns, setColumns] = React.useState(1);
    const spanning = rowSpanningCards(slot.entries);
    return (
        // A sheetless group gives the card row the same column edges as every other section.
        <ItemGroup surface="none">
            <CardGrid testID={`home-hub.${slot.key}`} columns={HOME_HUB_CARD_ROW_COLUMNS} onColumnCountChange={setColumns}>
                {slot.entries.map((entry) => {
                    const span = spanning.has(entry.section.id) ? 'row' : undefined;
                    const ownsRow = span === 'row' && columns > 1 && !spansRow(entry.section);
                    return (
                        <CardGridCell key={entry.section.id} span={span}>
                            {renderSection(entry.section, entry.index, { ownsRow })}
                        </CardGridCell>
                    );
                })}
            </CardGrid>
        </ItemGroup>
    );
}

/** Home's composer section: it keeps the reading column wherever it is placed. */
export const HOME_HUB_COMPOSER_SECTION_ID = 'start';

/**
 * Home's sections below the header, on Home's `dashboard` page column: every block shares that
 * column's edges, wider than the composer (lab `.at-wsec`), grids fill that width, and consecutive cards
 * (widgets, Latest runs) form two-up rows. The composer keeps the reading column, centred, wherever
 * the person placed it. A card left alone in its row (alone in the run, or beside a full-width card) takes the whole
 * row rather than leaving a hole. Home and
 * its `/dev/home` fixture both lay out through this one owner.
 */
export function HomeHubSectionList(props: Readonly<{
    sections: readonly HomeHubSection<WidgetCandidate>[];
    renderSection: RenderSection;
}>) {
    return (
        <>
            {buildSlots(props.sections).map((slot) => {
                if (slot.kind === 'cards') return <CardRow key={slot.key} slot={slot} renderSection={props.renderSection} />;
                const block = props.renderSection(slot.entry.section, slot.entry.index, { ownsRow: false });
                return slot.entry.section.id === HOME_HUB_COMPOSER_SECTION_ID
                    ? <PageColumnProvider key={slot.key} value="reading">{block}</PageColumnProvider>
                    : <React.Fragment key={slot.key}>{block}</React.Fragment>;
            })}
        </>
    );
}
