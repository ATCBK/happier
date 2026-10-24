/** Stored identity is a descriptive fallback, never execution or installation authority. */
export function humanizeConnectedServiceIdentity(localId: string): string {
    return localId.trim().replace(/[-_/]+/g, ' ').replace(/(^|\s)\p{L}/gu, value => value.toLocaleUpperCase());
}
