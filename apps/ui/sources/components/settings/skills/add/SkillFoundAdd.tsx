import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ReachRulesChangeV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';
import type { SkillInstallPreviewV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';

import {
  CapabilityAddFooter,
  type CapabilityAddInputContext,
} from '@/components/capabilities/add/CapabilityAddModal';
import type { CapabilityFactsProps } from '@/components/capabilities/facts/CapabilityFacts';
import { buildCapabilityCollectionAnatomy } from '@/components/capabilities/row/buildCapabilityCollectionAnatomy';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SelectionCheckGlyph } from '@/components/ui/selection/SelectionCheckGlyph';
import { Text } from '@/components/ui/text/Text';
import { describeRegistrySourceStatus } from '@/registries/describeRegistrySourceStatus';
import type { MountedAuthoringActionExecute } from '@/sync/ops/actions/sessionAuthoringActions';
import { t } from '@/text';

import {
  SkillAddDetailBody,
  useSkillSiblingChoice,
  type SkillAddDetailInstalls,
} from './SkillAddDetailBody';
import { SkillInLibraryMark } from './SkillPreviewRows';
import {
  readAllHeldFooter,
  tickAllSkillPreviews,
  toggleSkillPreview,
} from './skillPreviewSelection';
import {
  installSkills,
  retrySkillInstallRules,
  type SkillInstallAcknowledgment,
  type SkillInstallSource,
} from './skillInstall';

type Preview = SkillInstallPreviewV1;
const keyOf = (item: Preview) => item.path;

/** A detail's own Add: in flight, or acknowledged (the content landed; its rules may still be missing). */
type DetailAdd =
  | Readonly<{ status: 'adding' }>
  | Readonly<{
      status: 'added';
      outcome: SkillInstallAcknowledgment;
      where?: ReachRulesChangeV1;
    }>;

/** Bytes a file carries, from its base64 body. */
function fileSize(contentBase64: string): number {
  const padding = contentBase64.endsWith('==')
    ? 2
    : contentBase64.endsWith('=')
      ? 1
      : 0;
  return Math.max(0, Math.floor((contentBase64.length * 3) / 4) - padding);
}

/**
 * What a link or an upload found, in the Add dialog's one list + details (lab sa L): a checklist row per skill (the
 * box ticks it; the row opens the same details Browse shows, with Where it's on), and the pinned footer that adds the
 * ticked ones in one call. A detail's Add to library adds that skill (and the siblings it keeps) with the Where the
 * person picked; the footer's Add sends no Where, like a Browse row's quick Add. A partial add keeps everything shown
 * and retries only the rules.
 */
export function SkillFoundAdd(
  props: Readonly<{
    ctx: CapabilityAddInputContext;
    execute: MountedAuthoringActionExecute;
    /** What `skills.install` adds from; null until something was found. */
    source: SkillInstallSource | null;
    items: readonly Preview[] | null;
    /** Stands where Browse has its search (the link field, the upload's choosers). */
    field?: React.ReactNode;
    /** Before anything is found. */
    empty: React.ReactNode;
    /** The facts' source for a found skill (its repository at the pin, or you). */
    factsSource: (item: Preview) => CapabilityFactsProps['source'];
    /** The details' "where it comes from" line. */
    installsSource?: (item: Preview) => SkillAddDetailInstalls['source'];
    /** The footer's quiet note while nothing failed. */
    note: React.ReactNode;
    /** The footer added the ticked ones: the dialog closes onto the first. */
    onAdded: (skillId: string) => void;
    /** A detail's Add (or Open) closed the dialog: the page selects that skill. */
    onSelectAdded: (skillId: string) => void;
    onDone: () => void;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const { execute, source } = props;
  const items = props.items ?? NONE;
  const several = items.length > 1;

  // Ticks follow the found set: a new find starts with every new skill ticked.
  const [ticks, setTicks] = React.useState(() => ({
    items,
    ticked: tickAllSkillPreviews(items),
  }));
  const ticked =
    ticks.items === items ? ticks.ticked : tickAllSkillPreviews(items);
  if (ticks.items !== items) setTicks({ items, ticked });
  const [adding, setAdding] = React.useState(false);
  const [addError, setAddError] = React.useState<string | null>(null);
  const [acknowledged, setAcknowledged] =
    React.useState<SkillInstallAcknowledgment | null>(null);
  const [detailAdds, setDetailAdds] = React.useState<
    ReadonlyMap<string, DetailAdd>
  >(() => new Map());
  const wheres = React.useRef(
    new Map<string, ReachRulesChangeV1 | undefined>(),
  );
  const selections = React.useRef(
    new Map<string, readonly string[] | undefined>(),
  );
  const locked = adding || acknowledged !== null;

  const toggle = React.useCallback(
    (path: string) => {
      if (locked) return;
      setAddError(null);
      setTicks((previous) => ({
        items,
        ticked: toggleSkillPreview(
          items,
          previous.items === items
            ? previous.ticked
            : tickAllSkillPreviews(items),
          path,
        ),
      }));
    },
    [items, locked],
  );

  const add = React.useCallback(async () => {
    if (source === null || items.length === 0) return;
    setAdding(true);
    setAddError(null);
    const outcome = acknowledged
      ? await retrySkillInstallRules(execute, acknowledged)
      : await installSkills(execute, {
          source,
          ...(several
            ? {
                selectPaths: items
                  .filter((item) => ticked.has(item.path))
                  .map((item) => item.path),
              }
            : {}),
        });
    setAdding(false);
    if (!outcome.ok) {
      setAddError(
        outcome.status
          ? describeRegistrySourceStatus(outcome.status)
          : t('capabilities.add.addFailed'),
      );
      return;
    }
    setAcknowledged(outcome);
    if (outcome.incomplete.length > 0) {
      setAddError(t('capabilities.skillAdd.partial.rules'));
      return;
    }
    props.onAdded(outcome.skillIds[0]!);
  }, [acknowledged, execute, items, props, several, source, ticked]);

  const nameByPath = React.useMemo(
    () => new Map(items.map((item) => [item.path, item.name])),
    [items],
  );
  const anatomy = React.useMemo(
    () => ({
      ...buildCapabilityCollectionAnatomy<Preview>({
        title: (item) => item.name,
        description: (item) => item.description,
        whereSummary: (item) =>
          item.inLibrary !== undefined ? (
            <SkillInLibraryMark
              testID={`${props.testID}.item.${item.name}.inLibrary`}
            />
          ) : null,
        facts: (item) => {
          const factsSource = props.factsSource(item);
          // A ticked skill names the siblings it brings along, so the reference holds once it is added.
          const alsoAdds =
            several && ticked.has(item.path)
              ? (item.siblingSkills ?? [])
                  .filter((sibling) => ticked.has(sibling.path))
                  .map(
                    (sibling) => nameByPath.get(sibling.path) ?? sibling.path,
                  )
              : [];
          return {
            presentation: 'row',
            ...(factsSource ? { source: factsSource } : {}),
            trust: item.trust,
            cost: { tokensWhenUsed: item.cost.bodyTokens },
            ...(alsoAdds.length > 0
              ? {
                  extra: alsoAdds.map((name) =>
                    t('capabilities.skillAdd.alsoAdds', { name }),
                  ),
                }
              : {}),
          } satisfies CapabilityFactsProps;
        },
        accessibilityLabel: (item) => item.name,
        testID: (item) => `${props.testID}.item.${item.name}`,
      }),
      // Several found: a checklist. The box is its own control; pressing the row opens the details.
      ...(several
        ? {
            leadingControl: (item: Preview) => {
              const held = item.inLibrary !== undefined;
              const checked = !held && ticked.has(item.path);
              return (
                <IconButton
                  testID={`${props.testID}.item.${item.name}.tick`}
                  variant="plain"
                  size={24}
                  accessibilityRole="checkbox"
                  checked={checked}
                  selectedBackground={false}
                  disabled={held || locked}
                  accessibilityLabel={item.name}
                  icon={
                    <SelectionCheckGlyph
                      state={checked ? 'checked' : 'unchecked'}
                    />
                  }
                  onPress={() => toggle(item.path)}
                />
              );
            },
          }
        : {}),
    }),
    [locked, nameByPath, props, several, ticked, toggle],
  );

  const renderDetail = React.useCallback(
    (item: Preview) => (
      <SkillFoundDetail
        key={item.path}
        item={item}
        items={items}
        factsSource={props.factsSource(item)}
        installsSource={props.installsSource?.(item)}
        onOpenHeld={props.onSelectAdded}
        onWhereChange={(where) => wheres.current.set(item.path, where)}
        onSelectionChange={(paths) => selections.current.set(item.path, paths)}
        testID={`${props.testID}.detail`}
      />
    ),
    [items, props],
  );

  const detailFooter = React.useCallback(
    (item: Preview) => {
      const note = <View style={styles.note}>{props.note}</View>;
      if (item.inLibrary !== undefined) {
        const held = item.inLibrary;
        return {
          provenance: note,
          primary: {
            label: t('capabilities.skillAdd.open'),
            onPress: async () => ({ itemId: held }),
          },
        };
      }
      const state = detailAdds.get(item.path);
      const setState = (next: DetailAdd) =>
        setDetailAdds((previous) => new Map(previous).set(item.path, next));
      if (state?.status === 'added' && state.outcome.incomplete.length > 0) {
        const acknowledgedAdd = state;
        return {
          provenance: (
            <Text
              variant="meta"
              style={{ color: theme.colors.status.error }}
              testID={`${props.testID}.detail.partial`}
            >
              {t('capabilities.skillAdd.partial.rules')}
            </Text>
          ),
          primary: {
            label: t('capabilities.skillAdd.partial.tryAgain'),
            onPress: async () => {
              const outcome = await retrySkillInstallRules(
                execute,
                acknowledgedAdd.outcome,
                acknowledgedAdd.where,
              );
              setState({ ...acknowledgedAdd, outcome });
              if (outcome.incomplete.length > 0)
                throw new Error(t('capabilities.skillAdd.partial.rules'));
              return { itemId: outcome.skillIds[0]! };
            },
          },
        };
      }
      return {
        provenance: note,
        primary: {
          label: t('capabilities.skillAdd.addToLibrary'),
          busy: state?.status === 'adding',
          ...(source === null || locked
            ? { disabledReason: t('capabilities.skillAdd.detail.loading') }
            : {}),
          onPress: async () => {
            if (source === null) return null;
            const where = wheres.current.get(item.path);
            setState({ status: 'adding' });
            const outcome = await installSkills(execute, {
              source,
              ...(several
                ? {
                    selectPaths: selections.current.get(item.path) ?? [
                      item.path,
                    ],
                  }
                : {}),
              ...(where ? { where } : {}),
            });
            if (!outcome.ok) {
              setDetailAdds((previous) => {
                const next = new Map(previous);
                next.delete(item.path);
                return next;
              });
              throw new Error(
                outcome.status
                  ? describeRegistrySourceStatus(outcome.status)
                  : t('capabilities.add.addFailed'),
              );
            }
            setState({ status: 'added', outcome, ...(where ? { where } : {}) });
            if (outcome.incomplete.length > 0)
              throw new Error(t('capabilities.skillAdd.partial.rules'));
            return { itemId: outcome.skillIds[0]! };
          },
        },
      };
    },
    [
      detailAdds,
      execute,
      locked,
      props.note,
      props.testID,
      several,
      source,
      theme.colors.status.error,
    ],
  );

  const allHeld = items.length > 0 ? readAllHeldFooter(items) : null;
  const footer =
    items.length === 0 ? undefined : (
      <CapabilityAddFooter
        testID={`${props.testID}.footer`}
        start={
          addError ? (
            <Text
              variant="meta"
              style={{ color: theme.colors.status.error }}
              testID={`${props.testID}.add-error`}
            >
              {addError}
            </Text>
          ) : (
            <View style={styles.note}>{props.note}</View>
          )
        }
      >
        {allHeld?.kind === 'open' ? (
          <RoundButton
            size="normal"
            title={t('capabilities.skillAdd.open')}
            onPress={() => props.onAdded(allHeld.skillId)}
            testID={`${props.testID}.add`}
          />
        ) : allHeld?.kind === 'done' ? (
          <RoundButton
            size="normal"
            title={t('capabilities.add.done')}
            onPress={props.onDone}
            testID={`${props.testID}.done`}
          />
        ) : (
          <RoundButton
            size="normal"
            title={
              acknowledged
                ? t('capabilities.skillAdd.partial.tryAgain')
                : several
                  ? t('capabilities.skillAdd.link.addSelected', {
                      count: ticked.size,
                    })
                  : t('capabilities.skillAdd.addToLibrary')
            }
            loading={adding}
            disabled={adding || (several && ticked.size === 0)}
            onPress={() => void add()}
            testID={`${props.testID}.add`}
          />
        )}
      </CapabilityAddFooter>
    );

  return props.ctx.renderFound<Preview>({
    ...(props.field === undefined ? {} : { field: props.field }),
    items,
    itemKey: keyOf,
    anatomy,
    empty: props.empty,
    ...(footer === undefined ? {} : { footer }),
    renderDetail,
    detailFooter,
    onAdded: ({ itemId }) => props.onSelectAdded(itemId),
  });
}

const NONE: readonly Preview[] = [];

/** A found skill's details: Browse's details over the preview the link or upload returned. */
function SkillFoundDetail(
  props: Readonly<{
    item: Preview;
    items: readonly Preview[];
    factsSource: CapabilityFactsProps['source'];
    installsSource: SkillAddDetailInstalls['source'] | undefined;
    onOpenHeld: (skillId: string) => void;
    onWhereChange: (where: ReachRulesChangeV1 | undefined) => void;
    onSelectionChange: (selectPaths: readonly string[] | undefined) => void;
    testID: string;
  }>,
) {
  const { item, items } = props;
  const siblings = React.useMemo(() => {
    const referenced = new Set(
      (item.siblingSkills ?? []).map((sibling) => sibling.path),
    );
    return items.filter((candidate) => referenced.has(candidate.path));
  }, [item.siblingSkills, items]);
  const choice = useSkillSiblingChoice({
    primary: item,
    siblings,
    outsideReferences: item.outsideReferences ?? NO_REFERENCES,
    onOpenHeld: props.onOpenHeld,
    testID: props.testID,
  });
  const { onSelectionChange } = props;
  React.useEffect(() => {
    onSelectionChange(choice.selectPaths);
  }, [choice.selectPaths, onSelectionChange]);
  const files = React.useMemo(
    () =>
      item.files.map((file) => ({
        path: file.path,
        size: fileSize(file.contentBase64),
      })),
    [item.files],
  );
  return (
    <SkillAddDetailBody
      testID={props.testID}
      title={item.name}
      purpose={item.description}
      facts={{
        presentation: 'row',
        ...(props.factsSource ? { source: props.factsSource } : {}),
        trust: item.trust,
        cost: { tokensWhenUsed: item.cost.bodyTokens },
      }}
      installs={{
        trust: item.trust,
        scripts: item.files.filter((file) => file.unixMode === 0o755).length,
        files,
        cost: item.cost,
        ...(props.installsSource ? { source: props.installsSource } : {}),
      }}
      outsideReferences={choice.stillOutside}
      siblings={choice.rows}
      onWhereChange={props.onWhereChange}
    />
  );
}

const NO_REFERENCES: readonly string[] = [];

const styles = StyleSheet.create((theme) => ({
  note: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    minWidth: 0,
  },
}));
