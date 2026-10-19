import type { PluginWorkItemsResolveRequestV1, PluginWorkItemsResolveResultV1, PluginWorkItemsFindLinkedRequestV1, PluginWorkItemsWatchRequestV1 } from '@happier-dev/protocol/plugins/contributions/workItems';

export type { PluginWorkItemV1, PluginWorkItemCategoryV1, PluginWorkItemsContributionV1, PluginWorkItemsResolveRequestV1, PluginWorkItemsResolveResultV1, PluginWorkItemsFindLinkedRequestV1, PluginWorkItemsWatchRequestV1, PluginWorkItemTransitionInputV1 } from '@happier-dev/protocol/plugins/contributions/workItems';

/** Live read callbacks reuse the source's item/link owners; the host stores no mirror. */
export interface PluginWorkItemsRuntime {
  resolve(request: PluginWorkItemsResolveRequestV1, context: Readonly<{ signal: AbortSignal }>): Promise<PluginWorkItemsResolveResultV1>;
  findLinked?(request: PluginWorkItemsFindLinkedRequestV1, context: Readonly<{ signal: AbortSignal }>): Promise<readonly string[]>;
  /** Invalidation only. The host re-reads and owns subscription retirement. */
  watch?(request: PluginWorkItemsWatchRequestV1, onChange: () => void): () => void;
}
