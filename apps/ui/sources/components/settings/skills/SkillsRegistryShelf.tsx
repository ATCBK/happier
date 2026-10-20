import * as React from 'react';
import { RegistryShelf, registryShelfCardKey } from '@/components/capabilities/add/RegistryShelf';
import type { RegistryItemSummaryV1 } from '@happier-dev/protocol/registries';
import { findHeldSkillV1, type SkillListItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { useRegistrySources } from '@/registries/useRegistrySources';
import type { SkillsLibrary } from '@/sync/domains/skills/useSkillsLibrary';
import { installSkills } from './add/skillInstall';
import { useOpenSkillAddModal } from './add/useOpenSkillAddModal';
import { t } from '@/text';

const SHELF_SIZE = 3;

type ShelfCard = RegistryItemSummaryV1;
type AddState = Readonly<{ status: 'adding' | 'added' | 'failed' }>;

const cardKey = registryShelfCardKey;

function repositoryLabel(url: string | undefined): string | null {
  if (!url) return null;
  const match = /github\.com[/:]([^/]+\/[^/#?]+)/.exec(url);
  return match ? match[1]!.replace(/\.git$/, '') : null;
}

function inLibrary(
  items: readonly SkillListItemV1[],
  card: ShelfCard,
): boolean {
  return findHeldSkillV1(items, { registry: card }) !== null;
}

/**
 * "From your registries" (P6 §4.2, IR-79): P4's one suggestions rule (Happier picks of the kind, else the
 * first page of the first built-in source this host reads directly) as three cards with Add. No items, no
 * shelf: never an empty one.
 */
export const SkillsRegistryShelf = React.memo(function SkillsRegistryShelf(
  props: Readonly<{
    library: SkillsLibrary;
    shelf: Readonly<{
      items: readonly ShelfCard[];
      sourceId: string | null;
      loading: boolean;
    }>;
    brandNew: boolean;
  }>,
) {
  const { library, shelf } = props;
  const sources = useRegistrySources('skill');
  const { execute } = useMountedActionExecution(
    library.scope?.serverId ?? null,
  );
  const [adds, setAdds] = React.useState<ReadonlyMap<string, AddState>>(
    new Map(),
  );
  const cards = React.useMemo(
    () => shelf.items.slice(0, SHELF_SIZE),
    [shelf.items],
  );
  const sourceTitle =
    sources.sources.find((source) => source.id === shelf.sourceId)?.title ??
    null;
  const { retry } = library;
  // "Browse all" opens the same Add modal on Browse, on the registry these cards came from.
  const openAdd = useOpenSkillAddModal();

  const add = React.useCallback(
    async (card: ShelfCard) => {
      const key = cardKey(card);
      setAdds((previous) => new Map(previous).set(key, { status: 'adding' }));
      // The row's Add reads the item first and installs exactly that pinned version, with no Where (P6 §4.4).
      const read = await execute('registries.items.read', { kind: 'skill', sourceId: card.sourceId, itemId: card.itemId })
        .catch(() => null);
      const version = read?.ok ? (read.result as { item?: { summary?: { version?: string } } } | undefined)?.item?.summary?.version : undefined;
      const result = version
        ? await installSkills(execute, { source: { kind: 'registry', sourceId: card.sourceId, itemId: card.itemId, version } })
          .catch(() => ({ ok: false as const, error: 'skill_install_failed' }))
        : { ok: false as const, error: 'registry_version_unavailable' };
      setAdds((previous) =>
        new Map(previous).set(key, { status: result.ok ? 'added' : 'failed' }),
      );
      if (result.ok) retry();
    },
    [execute, retry],
  );

  const where = React.useCallback(
    (card: ShelfCard) =>
      card.publisher?.name ??
      repositoryLabel(card.links?.repository) ??
      sourceTitle ??
      card.sourceId,
    [sourceTitle],
  );
  const action = React.useCallback(
    (card: ShelfCard) => {
      const state = adds.get(cardKey(card));
      if (state?.status === 'added' || inLibrary(library.items, card))
        return (
          <RoundButton
            testID={`skills.home.shelf.${card.itemId}.added`}
            size="small"
            display="inverted"
            title={t('capabilities.skillsUpdates.shelf.inLibrary')}
            disabled
          />
        );
      return (
        <RoundButton
          testID={`skills.home.shelf.${card.itemId}.add`}
          size="small"
          display="secondary"
          title={
            state?.status === 'failed'
              ? t('capabilities.skillsUpdates.shelf.addFailed')
              : t('capabilities.skillsUpdates.shelf.add')
          }
          loading={state?.status === 'adding'}
          disabled={state?.status === 'adding'}
          onPress={() => void add(card)}
        />
      );
    },
    [add, adds, library.items],
  );

  return (
    <RegistryShelf
      testID="skills.home.shelf"
      title={
        props.brandNew
          ? t('capabilities.skillsUpdates.shelf.titleNew')
          : t('capabilities.skillsUpdates.shelf.title')
      }
      {...(sourceTitle
        ? {
            description: t('capabilities.skillsUpdates.shelf.fromSource', {
              source: sourceTitle,
            }),
          }
        : {})}
      items={cards}
      loading={shelf.loading}
      where={where}
      action={action}
      columnTitle={t('capabilities.skills.title')}
      browseAll={{ label: t('capabilities.skillsUpdates.shelf.browseAll'), onPress: () => openAdd({ modeKey: 'browse', ...(shelf.sourceId ? { sourceId: shelf.sourceId } : {}) }) }}
    />
  );
});
