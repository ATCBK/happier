import * as React from 'react';

export type DiscussionRightSidebarTabId = 'discussionParticipants' | 'discussionAgents' | 'discussionDetails';

/** What the open Discussion shows in each tab; the page owns the state, the sidebar only places it. */
export type DiscussionRightSidebarPanels = Readonly<Record<DiscussionRightSidebarTabId, React.ReactNode>>;

/**
 * The route hosts the pane; the open Discussion inside it owns the state its tabs show. The Discussion
 * publishes its panels here and only the side pane subscribes, so typing in the thread never renders the
 * route, and a Discussion shown without this host (a Session's side pane, a phone) publishes nothing.
 */
export type DiscussionRightSidebarPanelsStore = Readonly<{
    publish: (panels: DiscussionRightSidebarPanels | null) => void;
    subscribe: (listener: () => void) => () => void;
    read: () => DiscussionRightSidebarPanels | null;
}>;

export function createDiscussionRightSidebarPanelsStore(): DiscussionRightSidebarPanelsStore {
    let panels: DiscussionRightSidebarPanels | null = null;
    const listeners = new Set<() => void>();
    return {
        publish: (next) => {
            panels = next;
            for (const listener of listeners) listener();
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        read: () => panels,
    };
}

export const DiscussionRightSidebarPanelsContext = React.createContext<DiscussionRightSidebarPanelsStore | null>(null);

/** Whether the page shows the Discussion rail (so its header leaves participants and settings to it). */
export function useDiscussionRightSidebarHosted(): boolean {
    return React.useContext(DiscussionRightSidebarPanelsContext) !== null;
}

/** The open Discussion's panels, published after each render; withdrawn when it closes. */
export function usePublishDiscussionRightSidebarPanels(panels: DiscussionRightSidebarPanels | null): void {
    const store = React.useContext(DiscussionRightSidebarPanelsContext);
    React.useEffect(() => { store?.publish(panels); });
    React.useEffect(() => () => store?.publish(null), [store]);
}

