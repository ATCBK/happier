/** @moduleRealm any */

/**
 * The public authoring contract of `contributes.searchProviders`.
 *
 * There is one query schema and one result schema across Protocol, the SDK,
 * the host projection and the universal boundary, and they are composable
 * Protocol schemas rather than hand-written JSON Schemas. An author declares
 * these exact values on the referenced Action, so the handler keeps its
 * inferred `{ query, limit } → { items, truncated }` types, Action dispatch
 * validates against the same value the host published, and no side compares
 * two JSON Schemas for equivalence.
 *
 * This is deliberately NOT the composer-reference contract: a composer
 * reference resolves model-facing context into a draft, while a search provider
 * returns host-rendered entities a reader opens or executes.
 */
import { PluginSearchItemV1Schema as canonicalPluginSearchItemV1Schema, PluginSearchQueryV1Schema as canonicalPluginSearchQueryV1Schema, PluginSearchResultV1Schema as canonicalPluginSearchResultV1Schema } from '@happier-dev/protocol/plugins/contributions/search-providers';
import type { ProtocolComposableSchema } from './protocol/protocolFacade.js';
import { projectProtocolValue } from './protocol/projectProtocolValue.js';
import type {
  PluginUiIconTokenV1,
  PluginUiSemanticCommandV1,
} from './ui/publicContract.js';

export { MAX_PLUGIN_SEARCH_ITEM_COMMAND_UTF8_BYTES_V1 } from '@happier-dev/protocol/plugins/contributions/search-providers';

export type PluginSearchProviderContributionV1 = Readonly<{
  id: string;
  action: string;
}>;

export type PluginSearchQueryV1 = Readonly<{
  query: string;
  limit: number;
}>;

export type PluginSearchItemV1 = Readonly<{
  id: string;
  title: string;
  subtitle?: string;
  icon?: PluginUiIconTokenV1;
  command: PluginUiSemanticCommandV1;
}>;

export type PluginSearchResultV1 = Readonly<{
  items: readonly PluginSearchItemV1[];
  truncated: boolean;
  /** A known acquisition failure; omitted for an ordinary successful result. */
  failure?: Readonly<{ code: 'root_not_found' | 'unavailable' | 'auth_required' }>;
}>;

/**
 * Declaration-neutral SDK projections of Protocol's one canonical schema
 * values. Explicit local signatures keep the public author graph on the SDK's
 * existing JSON/UI vocabulary while the runtime objects and validators remain
 * Protocol-owned.
 */
export const PluginSearchQueryV1Schema: ProtocolComposableSchema<
  PluginSearchQueryV1,
  PluginSearchQueryV1
> = canonicalPluginSearchQueryV1Schema;

export const PluginSearchItemV1Schema: ProtocolComposableSchema<
  PluginSearchItemV1,
  PluginSearchItemV1
> = /* @__PURE__ */ projectProtocolValue(canonicalPluginSearchItemV1Schema);

export const PluginSearchResultV1Schema: ProtocolComposableSchema<
  PluginSearchResultV1,
  PluginSearchResultV1
> = /* @__PURE__ */ projectProtocolValue(canonicalPluginSearchResultV1Schema);
