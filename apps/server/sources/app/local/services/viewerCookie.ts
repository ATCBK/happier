/** HTTPS preview admission stays host-only and scoped to its top-level viewer site. */
export function scopedLocalServiceViewerTokenCookie(input: Readonly<{
    name: 'happier_preview_token' | 'happier_public_token';
    path: string;
    rawToken: string;
}>): string {
    return [
        `${input.name}=${encodeURIComponent(input.rawToken)}`,
        `Path=${input.path}`,
        'HttpOnly',
        // Preview frames can be cross-site relative to the app. Lax rejects their
        // exchange cookie; partitioning confines it to the embedding site's jar.
        'SameSite=None',
        'Secure',
        'Partitioned',
    ].join('; ');
}
