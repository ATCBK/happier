/**
 * Admitted preview origins keep host-only cookies scoped to their top-level viewer site.
 * Secure and Partitioned also apply to loopback HTTP: Chromium admits localhost names
 * for both attributes. Browsers without that exception require HTTPS/native direct access;
 * dropping Secure would also invalidate SameSite=None and partitioning.
 */
export function scopedLocalServiceViewerTokenCookie(input: Readonly<{
    name: 'happier_preview_token' | 'happier_public_token';
    path: string;
    value: string;
}>): string {
    return [
        `${input.name}=${encodeURIComponent(input.value)}`,
        `Path=${input.path}`,
        'HttpOnly',
        // Preview frames can be cross-site relative to the app. Lax rejects their
        // exchange cookie; partitioning confines it to the embedding site's jar.
        'SameSite=None',
        'Secure',
        'Partitioned',
    ].join('; ');
}
