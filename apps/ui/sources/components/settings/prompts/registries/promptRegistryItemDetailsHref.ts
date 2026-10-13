import type { RegistryItemSummaryV1 } from '@happier-dev/protocol/registries';

export function buildPromptRegistryItemDetailsHref(args: Readonly<{
  item: RegistryItemSummaryV1;
  workspacePath?: string | null;
}>): string {
  const params = new URLSearchParams({
    sourceId: args.item.sourceId,
    itemId: args.item.itemId,
    title: args.item.title,
    displayPath: args.item.itemId,
  });
  if (typeof args.workspacePath === 'string' && args.workspacePath.trim().length > 0) {
    params.set('workspacePath', args.workspacePath.trim());
  }
  return `/(app)/settings/prompts/registries/item?${params.toString()}`;
}
