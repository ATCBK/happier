import * as React from 'react';
import { getWidgetSizeFootprintV1 } from '@happier-dev/protocol/widgets';

import { CardGrid, CardGridCell } from '@/components/ui/cardGrid/CardGrid';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
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
 * slot keyed by its id, and a card row is keyed by its first card, so data arriving in one section
 * (usage, machines, a widget's rows) never changes the page's structure or remounts a neighbour.
 */
function buildSlots(sections: readonly HomeHubSection<WidgetCandidate>[]): Slot[] {
    const slots: Slot[] = [];
    let run: Placed[] = [];
    const flush = () => {
        if (run.length > 0) slots.push({ kind: 'cards', key: `cards:${run[0]!.section.id}`, entries: run });
        run = [];
    };
    sections.forEach((section, index) => {
        if (section.hidden) return;
        if (isHomeHubCardSection(section)) {
            run.push({ section, index });
            return;
        }
        flush();
        slots.push({ kind: 'single', key: section.id, entry: { section, index } });
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

/**
 * Home's sections below the header, on one column: every block shares the page column's edges
 * (the composer's width), grids fill that width, and consecutive cards (widgets, Latest runs) form
 * two-up rows. A card left alone in its row (alone in the run, or beside a full-width card) takes the whole
 * row rather than leaving a hole. Home and
 * its `/dev/home` fixture both lay out through this one owner.
 */
export function HomeHubSectionList(props: Readonly<{
    sections: readonly HomeHubSection<WidgetCandidate>[];
    renderSection: (section: HomeHubSection<WidgetCandidate>, index: number) => React.ReactNode;
}>) {
    return (
        <>
            {buildSlots(props.sections).map((slot) => {
                if (slot.kind === 'single') {
                    return <React.Fragment key={slot.key}>{props.renderSection(slot.entry.section, slot.entry.index)}</React.Fragment>;
                }
                const spanning = rowSpanningCards(slot.entries);
                return (
                    // A sheetless group gives the card row the same column edges as every other section.
                    <ItemGroup key={slot.key} surface="none">
                        <CardGrid testID={`home-hub.${slot.key}`} columns={HOME_HUB_CARD_ROW_COLUMNS}>
                            {slot.entries.map((entry) => (spanning.has(entry.section.id) ? (
                                <CardGridCell key={entry.section.id} span="row">
                                    {props.renderSection(entry.section, entry.index)}
                                </CardGridCell>
                            ) : (
                                <React.Fragment key={entry.section.id}>{props.renderSection(entry.section, entry.index)}</React.Fragment>
                            )))}
                        </CardGrid>
                    </ItemGroup>
                );
            })}
        </>
    );
}
