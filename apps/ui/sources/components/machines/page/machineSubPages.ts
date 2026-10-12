import type { TranslationKeyNoParams } from '@/text';

/**
 * The pages "This machine" pushes in the detail pane (lab `DD`), in the order its rows list them. Project work
 * leads: the work other programs run here (workers, runs, recent sessions, terminals) is one page, so the Overview
 * keeps the lab's one quiet row for it (lab `R`).
 */
export const MACHINE_THIS_MACHINE_PAGES = ['work', 'sharing', 'agents', 'terminal', 'installables', 'doctor', 'connection', 'details'] as const;
export type MachineThisMachinePageId = typeof MACHINE_THIS_MACHINE_PAGES[number];

/** Every page a machine pushes: This machine's rows, then the Overview's Alerts row (plan 20 VIT-15). */
export const MACHINE_SUB_PAGES = [...MACHINE_THIS_MACHINE_PAGES, 'alerts'] as const;
export type MachineSubPageId = typeof MACHINE_SUB_PAGES[number];

export function isMachineSubPageId(value: unknown): value is MachineSubPageId {
    return typeof value === 'string' && (MACHINE_SUB_PAGES as readonly string[]).includes(value);
}

/** Each sub-page's title: its This machine row and its own page header say the same word. */
export const MACHINE_SUB_PAGE_TITLE_KEYS = {
    work: 'machineDetailPage.subPages.work',
    sharing: 'machineDetailPage.subPages.sharing',
    agents: 'machineDetailPage.subPages.agents',
    terminal: 'machineDetailPage.subPages.terminal',
    connection: 'machineDetailPage.subPages.connection',
    installables: 'machineDetailPage.subPages.tools',
    doctor: 'machineDetailPage.subPages.doctor',
    details: 'machineDetailPage.subPages.details',
    alerts: 'machineVitals.alerts.title',
} as const satisfies Record<MachineSubPageId, TranslationKeyNoParams>;
