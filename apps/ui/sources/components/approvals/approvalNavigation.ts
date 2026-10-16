/** The existing Inbox detail route, typed for navigation and string-valued Action links. */
export function buildApprovalHref(artifactId: string, serverId: string, completionHref?: string): `/inbox/approvals/${string}?serverId=${string}` {
    const completion = completionHref ? `&completionHref=${encodeURIComponent(completionHref)}` : '';
    return `/inbox/approvals/${encodeURIComponent(artifactId)}?serverId=${encodeURIComponent(serverId)}${completion}`;
}
