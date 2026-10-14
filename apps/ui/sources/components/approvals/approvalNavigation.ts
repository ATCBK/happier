import type { Href } from 'expo-router';

/** The existing Inbox detail route, typed for navigation and string-valued Action links. */
export function buildApprovalHref(artifactId: string, serverId: string): Href & string {
    return `/inbox/approvals/${encodeURIComponent(artifactId)}?serverId=${encodeURIComponent(serverId)}`;
}
