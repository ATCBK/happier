/** HTTPS preview cookies stay host-only and scoped to their top-level viewer site. */
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
