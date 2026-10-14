import { canonicalizeServerUrl } from '../../sync/domains/server/url/serverUrlCanonical';

/** Resolves the credential-owning Home selected by the embedding UI URL. */
export function resolveEmbedEndpointUrl(search: string, fallbackUrl: string): string {
    const selected = canonicalizeServerUrl(new URLSearchParams(search).get('server') ?? '');
    return selected || fallbackUrl;
}
