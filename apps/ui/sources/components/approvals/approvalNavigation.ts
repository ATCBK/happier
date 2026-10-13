/** The existing Inbox detail route for one approval on the Home that holds it. */
export function buildApprovalHref(artifactId: string, serverId: string): string {
    return `/inbox/approvals/${encodeURIComponent(artifactId)}?serverId=${encodeURIComponent(serverId)}`;
}
