import { lazyZodSchema } from '../lazyZodSchema.js';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

import { z } from 'zod';

const MarketplaceSourceUrlV1Schema = lazyZodSchema(() => z.string().trim().min(1).transform((value, context) => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || !url.hostname) {
      context.addIssue({ code: 'custom', message: 'Expected a credential-free HTTPS marketplace source URL' });
      return z.NEVER;
    }
    return url.toString();
  } catch {
    context.addIssue({ code: 'custom', message: 'Expected a credential-free HTTPS marketplace source URL' });
    return z.NEVER;
  }
}));

export const DEFAULT_CURATED_MARKETPLACE_SOURCE_TITLE = 'Happier curated marketplace';
export const PUBLIC_NPM_REGISTRY_ORIGIN_V1 = 'https://registry.npmjs.org';
export const COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1 = 'marketplace:community-npm';
export const DEFAULT_CURATED_MARKETPLACE_SOURCE_DESCRIPTION = 'Official curated source';
export const DEFAULT_CURATED_MARKETPLACE_SOURCE_URL = 'https://marketplace.happier.dev/catalog.json';

export function normalizeMarketplaceSourceUrlV1(sourceUrl: string): string {
  return MarketplaceSourceUrlV1Schema.parse(String(sourceUrl ?? ''));
}

export function deriveMarketplaceSourceId(sourceUrl: string): string {
  return `marketplace:${bytesToHex(sha256(utf8ToBytes(String(sourceUrl ?? '').trim()))).slice(0, 12)}`;
}

export function deriveMarketplaceSourceTitle(sourceUrl: string): string {
  const normalized = String(sourceUrl ?? '').trim();
  try {
    const parsed = new URL(normalized);
    return parsed.hostname || parsed.href;
  } catch {
    return normalized;
  }
}
