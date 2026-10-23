import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HAPPIER_PICKS_SOURCE_ID,
  type RegistryItemSummaryV1,
  type RegistryItemV1,
} from '@happier-dev/protocol/registries';
import type { ReachRulesChangeV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';
import { findHeldSkillV1, type SkillListItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { deriveSkillTrustV1 } from '@happier-dev/protocol/prompts/library/skills/skillTrustV1';
import { estimateSkillCostV1 } from '@happier-dev/protocol/prompts/library/skills/skillCostV1';
import { readSkillOutsideReferencesV1 } from '@happier-dev/protocol/prompts/library/skills/skillReferencesV1';
import type { SkillInstallPreviewV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import {
  CapabilityAddModalBody,
  openCapabilityAddModalHost,
  type CapabilityAddModalConfig,
} from '@/components/capabilities/add/CapabilityAddModal';
import type { CapabilityTrust } from '@/components/capabilities/facts/CapabilityFacts';
import { buildCapabilityCollectionAnatomy } from '@/components/capabilities/row/buildCapabilityCollectionAnatomy';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { CustomModalInjectedProps } from '@/modal/types';
import { describeRegistrySourceStatus } from '@/registries/describeRegistrySourceStatus';
import { useRegistryItem } from '@/registries/useRegistryItem';
import { useRegistryItems } from '@/registries/useRegistryItems';
import { useRegistrySources } from '@/registries/useRegistrySources';
import { useRegistrySourcesSlot } from '@/registries/useRegistrySourcesSlot';
import { useSkillsLibrary } from '@/sync/domains/skills/useSkillsLibrary';
import { skillSource, skillSourceVerification } from '../skillsCollectionModel';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { t } from '@/text';

import { installSkills, previewSkillInstall, retrySkillInstall, describeSkillInstallIncomplete, type SkillInstallAcknowledgment } from './skillInstall';
import { SkillLinkInput } from './SkillLinkInput';
import { SkillUploadInput } from './SkillUploadInput';
import { SkillInLibraryMark } from './SkillPreviewRows';
import { SkillAddDetailBody, useSkillSiblingChoice } from './SkillAddDetailBody';
import type { MountedAuthoringActionExecute } from '@/sync/ops/actions/sessionAuthoringActions';

export type SkillAddModeKey = 'browse' | 'link' | 'upload' | 'write';

export type OpenSkillAddModalParams = Readonly<{
  modeKey?: SkillAddModeKey;
  sourceId?: string;
  query?: string;
  /** The page selects the new row (the first skill added). */
  onAdded?: (skillId: string) => void;
  /** Write: the page's draft (`/settings/skills/new`). */
  onWrite: () => void;
}>;

const TEST_ID = 'skills.add';

/** Add a skill (P6 §4.4): Browse your registries, From a link, Upload, or Write, in the one capability Add modal. */
export function openSkillAddModal(
  params: OpenSkillAddModalParams,
): Readonly<{ close: () => void }> {
  return openCapabilityAddModalHost(
    SkillAddModal,
    { params },
    { title: t('capabilities.skillAdd.title'), testID: TEST_ID },
  );
}

type Row = RegistryItemSummaryV1;
const rowKey = (row: Row) => `${row.sourceId}|${row.itemId}`;
const shortRef = (version: string | undefined) =>
  version && /^[0-9a-f]{40}$/.test(version)
    ? version.slice(0, 7)
    : (version ?? '');

function repositoryLabel(url: string | undefined): string | null {
  const match = url ? /github\.com[/:]([^/]+\/[^/#?]+)/.exec(url) : null;
  return match ? match[1]!.replace(/\.git$/, '') : null;
}
function libraryMatch(
  items: readonly SkillListItemV1[],
  row: Row,
): SkillListItemV1 | null {
  return findHeldSkillV1(items, { registry: row });
}
/** A listing whose "description" is only its repository says nothing the facts line doesn't: no second copy. */
function rowDescription(row: Row): string | null {
  const description = row.description?.trim();
  if (!description) return null;
  return description === repositoryLabel(row.links?.repository) || description === row.publisher?.name ? null : description;
}
function compactCount(count: number): string {
  return count >= 1000
    ? `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`
    : String(count);
}

type AddState =
  | Readonly<{ status: 'adding' }>
  | Readonly<{
      status: 'added';
      outcome: SkillInstallAcknowledgment;
      where?: ReachRulesChangeV1;
    }>
  | Readonly<{ status: 'failed'; error: string }>;

export function SkillAddModal(
  props: CustomModalInjectedProps &
    Readonly<{ params: OpenSkillAddModalParams }>,
): React.ReactElement {
  const { params } = props;
  const { theme } = useUnistyles();
  const scope = useAccountSettingsScope();
  const { execute } = useMountedActionExecution(scope?.serverId ?? null);
  const library = useSkillsLibrary();
  const { sources: allSources } = useRegistrySources('skill');
  const sourceTitle = React.useCallback(
    (sourceId: string) =>
      allSources.find((source) => source.id === sourceId)?.title ?? sourceId,
    [allSources],
  );

  const itemsFromSource = React.useCallback(
    (sourceId: string) =>
      library.items
        .filter(
          (item) =>
            item.provenance.kind === 'registry' &&
            item.provenance.registry.sourceId === sourceId,
        )
        .map((item) => ({
          title: item.name,
          ...(item.provenance.kind === 'registry' &&
          item.provenance.registry.ref.kind === 'gitTree'
            ? { ref: item.provenance.registry.ref.commit.slice(0, 7) }
            : {}),
          onOpen: () => {
            props.onClose();
            params.onAdded?.(item.skillId);
          },
        })),
    [library.items, params, props],
  );
  const slot = useRegistrySourcesSlot('skill', {
    itemsFromSource,
    ...(params.sourceId ? { initialSelection: params.sourceId } : {}),
    testID: `${TEST_ID}.registries`,
  });
  const [query, setQuery] = React.useState(params.query ?? '');
  const [catalogDemanded, setCatalogDemanded] = React.useState((params.modeKey ?? 'browse') === 'browse');
  const onModeChange = React.useCallback((key: string) => setCatalogDemanded(key === 'browse'), []);
  const catalog = useRegistryItems({
    kind: 'skill',
    ...(slot.sourceIds ? { sourceIds: slot.sourceIds } : {}),
    ...(query.trim() ? { query: query.trim() } : {}),
  }, catalogDemanded);

  // What the details read (the pinned version the primary installs) and what the person picked for Where.
  const [reads, setReads] = React.useState<ReadonlyMap<string, RegistryItemV1>>(
    () => new Map(),
  );
  // What the install preview says about each detail's primary: the held skill's id, null when it is new, undefined
  // until the preview has answered (the Action decides, including a Git identity from another source).
  const [heldByPreview, setHeldByPreview] = React.useState<ReadonlyMap<string, string | null | undefined>>(
    () => new Map(),
  );
  const onHeld = React.useCallback(
    (key: string, held: string | null | undefined) =>
      setHeldByPreview((previous) => (previous.get(key) === held && previous.has(key) ? previous : new Map(previous).set(key, held))),
    [],
  );
  const wheres = React.useRef(
    new Map<string, ReachRulesChangeV1 | undefined>(),
  );
  // The skills a detail adds: its own path and the referenced siblings the person kept (undefined: nothing to choose).
  const selections = React.useRef(
    new Map<string, readonly string[] | undefined>(),
  );
  const [adds, setAdds] = React.useState<ReadonlyMap<string, AddState>>(
    () => new Map(),
  );
  const setAdd = React.useCallback(
    (key: string, state: AddState) =>
      setAdds((previous) => new Map(previous).set(key, state)),
    [],
  );
  const onRead = React.useCallback(
    (key: string, item: RegistryItemV1) =>
      setReads((previous) =>
        previous.get(key) === item
          ? previous
          : new Map(previous).set(key, item),
      ),
    [],
  );

  const install = React.useCallback(
    async (
      row: Row,
      version: string,
      where: ReachRulesChangeV1 | undefined,
      selectPaths?: readonly string[],
    ) => {
      const key = rowKey(row);
      const previous = adds.get(key);
      if (previous?.status === 'added') {
        const outcome = await retrySkillInstall(execute, previous.outcome, previous.where);
        setAdd(key, { ...previous, outcome });
        library.retry();
        return outcome;
      }
      setAdd(key, { status: 'adding' });
      const outcome = await installSkills(execute, {
        source: {
          kind: 'registry',
          sourceId: row.sourceId,
          itemId: row.itemId,
          version,
        },
        ...(selectPaths ? { selectPaths } : {}),
        ...(where ? { where } : {}),
      });
      if (!outcome.ok && outcome.skillIds.length === 0) {
        setAdd(key, { status: 'failed', error: outcome.error });
        throw new Error(outcome.status ? describeRegistrySourceStatus(outcome.status) : t('capabilities.add.addFailed'));
      }
      setAdd(key, {
        status: 'added',
        outcome,
        ...(where ? { where } : {}),
      });
      library.retry();
      return outcome;
    },
    [adds, execute, library, setAdd],
  );

  // The row's quick Add reads the item first (the same pinned version) and sends no Where.
  const quickAdd = React.useCallback(
    async (row: Row) => {
      const key = rowKey(row);
      const previous = adds.get(key);
      if (previous?.status === 'added') {
        await install(row, '', previous.where);
        return;
      }
      setAdd(key, { status: 'adding' });
      const read = await execute('registries.items.read', {
        kind: 'skill',
        sourceId: row.sourceId,
        itemId: row.itemId,
      });
      const version = read.ok
        ? (read.result as { item?: RegistryItemV1 } | undefined)?.item?.summary
            .version
        : undefined;
      if (!version) {
        setAdd(key, {
          status: 'failed',
          error: 'registry_version_unavailable',
        });
        return;
      }
      await install(row, version, undefined).catch(() => undefined);
    },
    [adds, execute, install, setAdd],
  );

  const items = catalog.items;
  const groups = React.useMemo(() => {
    const picks = items
      .filter((row) => row.sourceId === HAPPIER_PICKS_SOURCE_ID)
      .map(rowKey);
    const rest = items
      .filter((row) => row.sourceId !== HAPPIER_PICKS_SOURCE_ID)
      .map(rowKey);
    const restTitle =
      slot.selection === 'all'
        ? t('capabilities.skillAdd.groupAll')
        : t('capabilities.skillAdd.groupSource', {
            source: sourceTitle(slot.selection),
          });
    return [
      ...(picks.length > 0
        ? [
            {
              key: 'picks',
              title: t('capabilities.skillAdd.groupPicks'),
              itemKeys: picks,
            },
          ]
        : []),
      ...(rest.length > 0
        ? [{ key: 'rest', title: restTitle, itemKeys: rest }]
        : []),
    ];
  }, [items, slot.selection, sourceTitle]);

  const anatomy = React.useMemo(
    () =>
      buildCapabilityCollectionAnatomy<Row>({
        title: (row) => row.title,
        description: rowDescription,
        whereSummary: (row) => {
          const state = adds.get(rowKey(row));
          const inLibrary =
            state?.status === 'added' ||
            libraryMatch(library.items, row) !== null;
          if (!inLibrary) return null;
          return <SkillInLibraryMark />;
        },
        facts: (row) => {
          const repo = repositoryLabel(row.links?.repository);
          return {
            presentation: 'row',
            ...(repo
              ? { source: { kind: 'git' as const, label: repo } }
              : row.publisher
                ? {
                    source: {
                      kind: 'registry' as const,
                      label: row.publisher.name,
                    },
                  }
                : {}),
            extra: [
              ...(row.installs !== undefined
                ? [compactCount(row.installs)]
                : []),
              t('capabilities.skillAdd.via', {
                source: sourceTitle(row.sourceId),
              }),
            ],
          };
        },
        action: (row) => {
          const key = rowKey(row);
          const state = adds.get(key);
          if (state?.status === 'added' && (!state.outcome.ok || state.outcome.incomplete.length > 0)) return (
            <SurfaceStateCard kind="error" size="line" title={describeSkillInstallIncomplete(state.outcome)}
              action={{ label: t('capabilities.skillAdd.partial.tryAgain'), onPress: () => quickAdd(row) }}
              testID={`${TEST_ID}.row.${row.itemId}.partial`} />
          );
          if (
            state?.status === 'added' ||
            libraryMatch(library.items, row) !== null ||
            row.problem
          )
            return null;
          return (
            <RoundButton
              size="small"
              display="secondary"
              title={
                state?.status === 'failed'
                  ? t('capabilities.skillAdd.partial.tryAgain')
                  : t('capabilities.skillAdd.add')
              }
              loading={state?.status === 'adding'}
              disabled={state?.status === 'adding'}
              onPress={() => void quickAdd(row)}
              testID={`${TEST_ID}.row.${row.itemId}.add`}
            />
          );
        },
        accessibilityLabel: (row) => row.title,
        testID: (row) => `${TEST_ID}.row.${row.itemId}`,
      }),
    [adds, library.items, quickAdd, sourceTitle, theme.colors.text.secondary],
  );

  const config = React.useMemo(
    (): CapabilityAddModalConfig<Row> => ({
      title: t('capabilities.skillAdd.title'),
      testID: TEST_ID,
      initialModeKey: params.modeKey ?? 'browse',
      onModeChange,
      modes: [
        {
          key: 'browse',
          label: t('capabilities.skillAdd.modes.browse'),
          icon: 'magnifying-glass',
          kind: 'catalog',
        },
        {
          key: 'link',
          label: t('capabilities.skillAdd.modes.link'),
          icon: 'link',
          kind: 'input',
          ownsTools: true,
          renderBody: (ctx) => (
            <SkillLinkInput
              ctx={ctx}
              execute={execute}
              onAdded={(skillId) => {
                library.retry();
                props.onClose();
                params.onAdded?.(skillId);
              }}
              onSelectAdded={(skillId) => {
                library.retry();
                params.onAdded?.(skillId);
              }}
              onDone={props.onClose}
              testID={`${TEST_ID}.link`}
            />
          ),
        },
        {
          key: 'upload',
          label: t('capabilities.skillAdd.modes.upload'),
          icon: 'upload',
          kind: 'input',
          ownsTools: true,
          renderBody: (ctx) => (
            <SkillUploadInput
              ctx={ctx}
              execute={execute}
              onAdded={(skillId) => {
                library.retry();
                props.onClose();
                params.onAdded?.(skillId);
              }}
              onSelectAdded={(skillId) => {
                library.retry();
                params.onAdded?.(skillId);
              }}
              onDone={props.onClose}
              testID={`${TEST_ID}.upload`}
            />
          ),
        },
        {
          key: 'write',
          label: t('capabilities.skillAdd.modes.write'),
          icon: 'pencil-simple',
          kind: 'handoff',
          onSelect: params.onWrite,
        },
      ],
      sources: slot.sources,
      catalog: {
        query,
        onQueryChange: setQuery,
        searchPlaceholder: t('capabilities.skillAdd.searchPlaceholder', {
          count: catalog.pages.reduce<number | null>(
            (sum, page) =>
              page.total === undefined || sum === null
                ? null
                : sum + page.total,
            catalog.pages.length > 0 ? 0 : null,
          ),
        }),
        items,
        groups,
        itemKey: rowKey,
        anatomy,
        loading: catalog.loading && items.length === 0,
        sourceFailures: catalog.sourceFailures.map((failure) => ({
          ...failure,
          message: `${sourceTitle(failure.sourceId)} · ${failure.message}`,
        })),
        empty: (
          <CatalogEmpty
            query={query}
            onClear={() => setQuery('')}
            onWrite={() => {
              props.onClose();
              params.onWrite();
            }}
          />
        ),
      },
      renderDetail: (row) => (
        <SkillAddDetail
          row={row}
          sourceTitle={sourceTitle(row.sourceId)}
          onRead={onRead}
          onHeld={onHeld}
          onOpenHeld={(skillId) => {
            props.onClose();
            params.onAdded?.(skillId);
          }}
          execute={execute}
          onWhereChange={(key, where) => {
            wheres.current.set(key, where);
          }}
          onSelectionChange={(key, selectPaths) => {
            selections.current.set(key, selectPaths);
          }}
        />
      ),
      detailFooter: (row) => {
        const key = rowKey(row);
        const read = reads.get(key) ?? null;
        // The preview after the item read is authoritative; the summary match only stands in until it answers.
        const previewedHeld = heldByPreview.get(key);
        const existingId =
          previewedHeld !== undefined ? previewedHeld : (libraryMatch(library.items, row)?.skillId ?? null);
        const state = adds.get(key);
        const version = read?.summary.version;
        const provenance = version ? (
        <View style={styles.provenance}>
          <Icon name="push-pin" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
          <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
            {t('capabilities.skillAdd.pinnedTo', { ref: shortRef(version) })}
          </Text>
        </View>
      ) : undefined;
        if (existingId !== null && state?.status !== 'added') {
          return {
            ...(provenance ? { provenance } : {}),
            primary: {
              label: t('capabilities.skillAdd.open'),
              onPress: async () => ({ itemId: existingId }),
            },
          };
        }
        if (state?.status === 'added') {
          const partial = !state.outcome.ok || state.outcome.incomplete.length > 0;
          return {
            provenance: partial ? <Text variant="meta" style={{ color: theme.colors.status.error }}>{describeSkillInstallIncomplete(state.outcome)}</Text> : provenance,
            primary: {
              label: t(partial ? 'capabilities.skillAdd.partial.tryAgain' : 'capabilities.skillAdd.open'),
              onPress: async () => {
                const outcome = partial ? await install(row, version ?? '', state.where) : state.outcome;
                if (!outcome.ok || outcome.incomplete.length > 0) throw new Error(describeSkillInstallIncomplete(outcome));
                return { itemId: outcome.skillIds[0]!, then: 'stay' as const };
              },
            },
          };
        }
        const problem = read?.summary.problem ?? row.problem;
        return {
          ...(provenance ? { provenance } : {}),
          primary: {
            label: t('capabilities.skillAdd.addToLibrary'),
            busy: state?.status === 'adding',
            ...(problem
              ? {
                  disabledReason: t(
                    'capabilities.skillAdd.detail.problemUnsupported',
                  ),
                }
              : !version || previewedHeld === undefined
                ? { disabledReason: t('capabilities.skillAdd.detail.loading') }
                : {}),
            onPress: async () => {
              const result = await install(
                row,
                version!,
                wheres.current.get(key),
                selections.current.get(key),
              );
              if (!result.ok || result.incomplete.length > 0) throw new Error(describeSkillInstallIncomplete(result));
              return { itemId: result.skillIds[0]! };
            },
          },
        };
      },
      onAdded: ({ itemId }) => params.onAdded?.(itemId),
    }),
    [
      adds,
      anatomy,
      catalog.loading,
      catalog.pages,
      catalog.sourceFailures,
      execute,
      groups,
      heldByPreview,
      install,
      items,
      library,
      onModeChange,
      onRead,
      params,
      props,
      query,
      reads,
      setAdd,
      slot.sources,
      sourceTitle,
      theme.colors.status.error,
      theme.colors.text.secondary,
    ],
  );

  return <CapabilityAddModalBody {...props} config={config} />;
}

function CatalogEmpty(props: Readonly<{ query: string; onClear: () => void; onWrite: () => void }>) {
  const { theme } = useUnistyles();
  const query = props.query.trim();
  if (!query) {
    // Registries that list nothing: what Browse is for, and the ways forward (the registry menu sits above; Write is
    // the one that leaves Browse). A failed source never reaches here: the body keeps its Retry line for that.
    return (
      <View style={styles.emptyPage}>
        <EmptyState
          layout="centered"
          size="page"
          scene="exploring"
          title={t('capabilities.skillAdd.emptyTitle')}
          subtitle={t('capabilities.skillAdd.emptyBody')}
          primaryAction={{
            label: t('capabilities.skills.home.writeOwn'),
            onPress: props.onWrite,
            testID: `${TEST_ID}.empty.write`,
          }}
          testID={`${TEST_ID}.empty`}
        />
      </View>
    );
  }
  return (
    <View style={styles.empty}>
      <Text variant="body" style={{ color: theme.colors.text.secondary }}>
        {t('capabilities.skillAdd.noMatch', { query })}
      </Text>
      <RoundButton
        size="small"
        display="inverted"
        title={t('capabilities.skillAdd.clear')}
        onPress={props.onClear}
      />
    </View>
  );
}

/**
 * A registry skill's details (lab sa A2): who it is with its pinned source, trust and cost; Where it's on (pick,
 * Everywhere by default); what it installs; what happens next; its files. Reads at the latest version once, and
 * hands that read up so the footer's Add installs exactly what is shown.
 */
function SkillAddDetail(
  props: Readonly<{
    row: Row;
    sourceTitle: string;
    execute: MountedAuthoringActionExecute;
    onRead: (key: string, item: RegistryItemV1) => void;
    onHeld: (key: string, held: string | null | undefined) => void;
    onOpenHeld: (skillId: string) => void;
    onWhereChange: (key: string, where: ReachRulesChangeV1 | undefined) => void;
    onSelectionChange: (key: string, selectPaths: readonly string[] | undefined) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const key = rowKey(props.row);
  const read = useRegistryItem({
    kind: 'skill',
    sourceId: props.row.sourceId,
    itemId: props.row.itemId,
  });
  const { onRead, onWhereChange } = props;
  React.useEffect(() => {
    if (read.item) onRead(key, read.item);
  }, [key, onRead, read.item]);
  const onWhere = React.useCallback((where: ReachRulesChangeV1 | undefined) => onWhereChange(key, where), [key, onWhereChange]);

  const skill =
    read.item?.payload.kind === 'skill' ? read.item.payload.skill : null;
  const trust: CapabilityTrust | undefined = skill
    ? deriveSkillTrustV1(skill.files)
    : undefined;
  const cost = skill ? estimateSkillCostV1(skill.skillMarkdown) : null;
  const outsideReferences = React.useMemo(
    () =>
      skill
        ? readSkillOutsideReferencesV1(
            skill.skillMarkdown,
            skill.files.map((file) => file.path),
          )
        : [],
    [skill],
  );
  // What adding this item would do, asked once the item is read (a dry run, nothing written): whether the library
  // already holds it, and the sibling skills of the same repository that its instructions refer to (added with it
  // unless unticked, or held already).
  const { execute, onSelectionChange, onHeld } = props;
  const version = read.item?.summary.version;
  const primaryPath = skill?.ref.kind === 'gitTree' ? skill.ref.path
    : skill?.ref.kind === 'wellKnown' ? skill.ref.name : undefined;
  const [offered, setOffered] = React.useState<Readonly<{ primary: SkillInstallPreviewV1; siblings: readonly SkillInstallPreviewV1[] }> | null>(null);
  React.useEffect(() => {
    setOffered(null);
    if (!version) {
      onHeld(key, undefined);
      return;
    }
    if (primaryPath === undefined) {
      onHeld(key, null);
      return;
    }
    onHeld(key, undefined);
    let current = true;
    void previewSkillInstall(execute, {
      kind: 'registry',
      sourceId: props.row.sourceId,
      itemId: props.row.itemId,
      version,
    }).then((preview) => {
      if (!current) return;
      const primary = preview.ok ? preview.items.find((item) => item.path === primaryPath) : undefined;
      // A preview that cannot answer leaves Add to the Action, which holds the same identity on commit.
      onHeld(key, primary?.inLibrary ?? null);
      if (!preview.ok || !primary) return;
      const siblings = preview.items.filter((item) => item.path !== primaryPath);
      if (siblings.length > 0) setOffered({ primary, siblings });
    });
    return () => {
      current = false;
    };
  }, [execute, key, onHeld, primaryPath, props.row.itemId, props.row.sourceId, version]);
  const siblingChoice = useSkillSiblingChoice({
    primary: offered?.primary ?? null,
    siblings: offered?.siblings ?? NO_PREVIEWS,
    outsideReferences,
    onOpenHeld: props.onOpenHeld,
    testID: `${TEST_ID}.detail`,
  });
  React.useEffect(() => {
    onSelectionChange(key, siblingChoice.selectPaths);
  }, [key, onSelectionChange, siblingChoice.selectPaths]);
  const ref = skill?.ref.kind === 'gitTree'
    ? skill.ref.commit.slice(0, 7)
    : shortRef(read.item?.summary.version);
  const repo = skill?.ref.kind === 'gitTree'
    ? (repositoryLabel(skill.ref.repo) ?? skill.ref.repo)
    : repositoryLabel(props.row.links?.repository);
  const indexSource = skill?.ref.kind === 'wellKnown' ? skillSource({ provenance: skill.ref }, (id) => id) : undefined;
  const indexVerification = skill?.ref.kind === 'wellKnown'
    ? skillSourceVerification({ provenance: skill.ref })
    : undefined;
  const problem = read.item?.summary.problem ?? props.row.problem;
  const purpose = (read.item ? rowDescription(read.item.summary) : null) ?? rowDescription(props.row);

  return (
    <SkillAddDetailBody
      testID={`${TEST_ID}.detail`}
      title={props.row.title}
      purpose={purpose}
      facts={{
        presentation: 'row',
        ...(indexSource && indexVerification ? { source: indexSource, extra: [indexVerification] }
          : repo ? { source: { kind: 'git' as const, label: repo, ...(ref ? { ref } : {}) } } : {}),
        ...(trust ? { trust } : {}),
        ...(cost ? { cost: { tokensWhenUsed: cost.bodyTokens } } : {}),
      }}
      notice={
        <>
          {problem ? (
            <Text variant="meta" style={{ color: theme.colors.state.warning.textForeground }}>
              {problem.code === 'too_large'
                ? t('capabilities.skillAdd.detail.problemTooLarge')
                : problem.code === 'removed_from_source'
                  ? t('capabilities.skillAdd.detail.problemRemoved')
                  : t('capabilities.skillAdd.detail.problemUnsupported')}
            </Text>
          ) : null}
          {read.error && !read.item ? (
            <View style={styles.partial} testID={`${TEST_ID}.detail.failure`}>
              <Text variant="meta" style={{ flexShrink: 1, color: read.status?.state === 'rate_limited' || read.status?.state === 'needs_machine'
                ? theme.colors.state.warning.textForeground : theme.colors.status.error }}>
                {read.status ? describeRegistrySourceStatus(read.status) : t('capabilities.skillAdd.detail.loadFailed')}
              </Text>
              <RoundButton size="small" display="secondary" title={t('capabilities.skillAdd.partial.tryAgain')}
                onPress={() => void read.refresh()} testID={`${TEST_ID}.detail.retry`} />
            </View>
          ) : null}
        </>
      }
      installs={
        skill && trust && cost
          ? {
              trust,
              scripts: skill.files.filter((file) => file.unixMode === 0o755).length,
              files: skill.files,
              cost,
              ...(indexSource?.kind === 'link' && indexVerification
                ? { source: { icon: 'link' as const, title: indexSource.host, subtitle: indexVerification } }
                : repo
                ? {
                    source: {
                      icon: 'github-logo' as const,
                      title: repo,
                      subtitle: t('capabilities.skillAdd.detail.sourceBody', { source: props.sourceTitle, ref }),
                    },
                  }
                : {}),
            }
          : null
      }
      outsideReferences={siblingChoice.stillOutside}
      siblings={siblingChoice.rows}
      onWhereChange={onWhere}
    />
  );
}

const NO_PREVIEWS: readonly SkillInstallPreviewV1[] = [];


const styles = StyleSheet.create((theme) => ({
  provenance: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  // Centred in the body the list leaves, as the Add-an-agent plugin source draws its empty state.
  emptyPage: { flex: 1, justifyContent: 'center' },
  empty: {
    alignItems: 'center',
    gap: theme.space.s12,
    paddingVertical: theme.space.s32,
  },
  partial: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
    flexWrap: 'wrap',
    marginTop: theme.space.s4,
  },
}));

