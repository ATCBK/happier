export const PANE_KEYBOARD_REGION_ORDER = ['rail', 'navigation', 'right', 'details', 'main', 'bottom'] as const;
export type PaneKeyboardRegion = typeof PANE_KEYBOARD_REGION_ORDER[number];
type PaneRegionFocusOwner = Readonly<{ visible: boolean; containsFocus: boolean; focus(): boolean }>;

/** Geometry owners publish visibility; cycling never guesses presentation from retained content. */
export function createPaneRegionFocusModel() {
    const owners = new Map<PaneKeyboardRegion, () => PaneRegionFocusOwner>();
    return {
        register(region: PaneKeyboardRegion, read: () => PaneRegionFocusOwner): () => void {
            owners.set(region, read);
            return () => { if (owners.get(region) === read) owners.delete(region); };
        },
        focus(direction: 'next' | 'previous'): boolean {
            const visible = PANE_KEYBOARD_REGION_ORDER.flatMap(region => {
                const owner = owners.get(region)?.();
                return owner?.visible ? [owner] : [];
            });
            if (visible.length === 0) return false;
            const focused = visible.findIndex(owner => owner.containsFocus);
            const step = direction === 'next' ? 1 : -1;
            const start = focused === -1 ? (step === 1 ? -1 : 0) : focused;
            for (let offset = 1; offset <= visible.length; offset += 1) {
                const candidate = visible[(start + step * offset + visible.length) % visible.length]!;
                if (candidate.focus()) return true;
            }
            return false;
        },
    };
}

export const paneRegionFocus = createPaneRegionFocusModel();
export function focusPaneRegion(direction: 'next' | 'previous'): boolean { return paneRegionFocus.focus(direction); }
