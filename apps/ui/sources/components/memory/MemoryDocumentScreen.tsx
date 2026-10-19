import {
  MEMORY_ARCHIVE_TOPIC_TITLE_V1,
  type MemoryFactV1,
} from '@happier-dev/protocol/prompts/library/memoryDocV1';
import {
  HAPPIER_COLLECTION_RAIL_WIDTH_PX,
  HappierListDetailLayout,
  useHappierCollectionLayout,
} from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import type { PageHeaderMetaFact } from '@/components/ui/layout/PageHeader';
import { NavigationBackChromeProvider } from '@/components/ui/layout/NavigationBackChrome';
import { NavigationTitleChromeProvider } from '@/components/ui/layout/navigationTitleChrome';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { MemoryDocumentBody, memoryTopicLabel } from './MemoryDocumentBody';
import { MemoryFactDetail } from './MemoryFactDetail';
import { memoryDocumentHref } from './memoryDocumentRoutes';
import { useMemoryDocument } from './useMemoryDocument';

/** The narrowest fact detail that keeps its labels beside their values. */
const FACT_DETAIL_MIN_WIDTH_PX = 420;

/**
 * A memory document's own pages (D48; lab K2 `A`/`Ap`): without `topic`, the index — every key fact,
 * decisions first, then the topic list; with `topic`, that one topic's facts (the archive is a topic).
 * A fact opens its detail (reason, source, approval, expiry, what agents see, history) beside the list
 * where both fit, and as its own pushed page on a phone. The selection is the route's `fact`.
 */
export const MemoryDocumentScreen = React.memo(function MemoryDocumentScreen(
  props: Readonly<{
    artifactId: string;
    serverId?: string;
    topic?: string;
    factId?: string;
  }>,
) {
  const scope = useActiveServerAccountScope();
  const serverId = props.serverId?.trim() || scope?.serverId || null;
  const ref = React.useMemo(
    () =>
      serverId
        ? { kind: 'doc' as const, artifactId: props.artifactId, serverId }
        : null,
    [props.artifactId, serverId],
  );
  const source = useMemoryDocument({
    ref,
    serverId,
    ...(props.topic ? { topic: props.topic } : {}),
  });
  const navigateToSession = useNavigateToSession();
  const router = useRouter();
  const { theme } = useUnistyles();
  const { fontScale } = useWindowDimensions();
  const openSession = React.useCallback(
    (target: Readonly<{ serverId: string; sessionId: string }>) => {
      fireAndForget(
        navigateToSession(target.sessionId, { serverId: target.serverId }),
        { tag: 'MemoryDocumentScreen.source' },
      );
    },
    [navigateToSession],
  );
  const [composing, setComposing] = React.useState(false);
  const view = source.view;
  // Only the qualified document read admits access; ambient same-id rows cannot grant it.
  const documentAccess = view?.access ?? null;
  const readOnly = documentAccess === null || documentAccess === 'view';
  const archive = props.topic === MEMORY_ARCHIVE_TOPIC_TITLE_V1;
  const title = props.topic
    ? memoryTopicLabel(props.topic)
    : (view?.title ?? t('memoryContext.memory.title'));
  const description = props.topic
    ? (view?.topic?.summary ?? '')
    : t('memoryContext.memory.pageDescription');
  // Who can see it and what this reader may do, from the admitted audience; unknown says nothing.
  const meta = React.useMemo((): PageHeaderMetaFact[] => {
    if (!view) return [];
    const facts: PageHeaderMetaFact[] = [];
    if (view.shared === true)
      facts.push({
        key: 'audience',
        icon: 'users',
        text: t('memoryContext.memory.accessShared'),
        testID: 'memory-document.audience',
      });
    if (view.shared === false)
      facts.push({
        key: 'audience',
        icon: 'lock',
        text: t('memoryContext.memory.accessPrivate'),
        testID: 'memory-document.audience',
      });
    if (documentAccess !== null)
      facts.push({
        key: 'access',
        text:
          documentAccess === 'view'
            ? t('memoryContext.memory.youCanView')
            : t('memoryContext.memory.youCanEdit'),
        testID: 'memory-document.access',
      });
    return facts;
  }, [documentAccess, view]);
  const selectedFact = React.useMemo(
    () =>
      props.factId
        ? (view?.facts.find((fact) => fact.id === props.factId) ?? null)
        : null,
    [props.factId, view?.facts],
  );
  const openFact = React.useCallback(
    (fact: MemoryFactV1 | null, replace: boolean) => {
      if (!ref) return;
      const href = memoryDocumentHref(ref, {
        serverId,
        ...(props.topic ? { topic: props.topic } : {}),
        ...(fact ? { factId: fact.id } : {}),
      });
      const result = runGuardedNavigation(() =>
        replace ? router.replace(href as never) : router.push(href as never),
      );
      if (result !== true)
        fireAndForget(result, { tag: 'MemoryDocumentScreen.openFact' });
    },
    [props.topic, ref, router, serverId],
  );
  const scale = Math.max(1, fontScale);
  // Decisions lead the list, so the first one shown is the first decision.
  const firstFact = view?.facts.find((fact) => fact.decision !== undefined) ?? view?.facts[0] ?? null;

  const list = (split: boolean) => (
    <ItemList>
      <SettingsPageHeader
        title={title}
        description={description}
        meta={props.topic ? undefined : meta}
      />
      <ItemGroup
        title={
          props.topic
            ? t('memoryContext.memory.factsTitle')
            : t('memoryContext.memory.keyFactsTitle')
        }
        description={
          props.topic
            ? undefined
            : t('memoryContext.memory.keyFactsDescription')
        }
        actionLayout="trailing"
        // Facts sit in their own slots; the group still knows how many can be selected.
        selectableItemCountOverride={view?.facts.length ?? 0}
        action={
          source.target && !readOnly && !archive ? (
            <IconButton
              testID="memory-document.remember"
              iconName="plus"
              variant="plain"
              accessibilityLabel={t('memoryContext.memory.remember')}
              tooltip={t('memoryContext.memory.remember')}
              onPress={() => setComposing(true)}
            />
          ) : undefined
        }
      >
        <MemoryDocumentBody
          testID="memory-document"
          source={source}
          serverId={serverId ?? ''}
          readOnly={readOnly}
          composing={composing}
          onComposingChange={setComposing}
          emptyText={t('memoryContext.memory.empty')}
          onOpenSession={openSession}
          // Beside the detail the selection moves in place; a phone pushes the fact's own page.
          onOpenFact={(fact) => openFact(fact, split)}
          selectedFactId={split ? (selectedFact?.id ?? null) : null}
          viewerAccountId={scope?.accountId ?? null}
        />
      </ItemGroup>
    </ItemList>
  );

  return (
    <View
      style={{
        flex: 1,
        minHeight: 0,
        backgroundColor: theme.colors.surface.base,
      }}
    >
      <HappierListDetailLayout
        testID="memory-document.layout"
        listTestID="memory-document.list-pane"
        detailTestID="memory-document.detail-pane"
        minListWidth={HAPPIER_COLLECTION_RAIL_WIDTH_PX.detailed * scale}
        minDetailWidth={FACT_DETAIL_MIN_WIDTH_PX * scale}
        preferredListRatio={0.5}
        listStyle={{
          borderRightWidth: 1,
          borderRightColor: theme.colors.border.default,
        }}
        list={(layout) => (
          <>
            <LandOnFirstFact
              split={layout?.mode === 'split'}
              selected={selectedFact !== null}
              first={firstFact}
              onLand={(fact) => openFact(fact, true)}
            />
            {list(layout?.mode === 'split')}
          </>
        )}
        detail={
          selectedFact ? (
            <FactDetailChrome key={selectedFact.id}>
            <MemoryFactDetail
              testID="memory-document.factDetail"
              fact={selectedFact}
              documentRef={ref}
              serverId={serverId}
              viewerAccountId={
                source.target?.accountId ?? scope?.accountId ?? null
              }
              archived={archive}
              onOpenSession={openSession}
            />
            </FactDetailChrome>
          ) : null
        }
        detailActive={selectedFact !== null}
        // While the document is read the split holds, so the list never jumps when the first fact lands.
        idleDetail={!view && source.status === 'loading' ? (
          <ItemList>
            <SurfaceStateCard testID="memory-document.factDetail.loading" kind="loading" title={t('common.loading')} />
          </ItemList>
        ) : null}
        stackedPane="detail"
      />
    </View>
  );
});

/** A wide document always shows a fact: beside the list, the first one opens on arrival. */
function LandOnFirstFact(
  props: Readonly<{
    split: boolean;
    selected: boolean;
    first: MemoryFactV1 | null;
    onLand: (fact: MemoryFactV1) => void;
  }>,
): null {
  const { split, selected, first } = props;
  const land = React.useRef(props.onLand);
  land.current = props.onLand;
  const firstId = first?.id ?? null;
  const firstRef = React.useRef(first);
  firstRef.current = first;
  React.useEffect(() => {
    if (split && !selected && firstId && firstRef.current) land.current(firstRef.current);
  }, [firstId, selected, split]);
  return null;
}

/**
 * Beside the list the fact is a pane of this page: the page keeps its own title and back.
 */
function FactDetailChrome(props: Readonly<{ children: React.ReactNode }>) {
  const split = useHappierCollectionLayout()?.mode === 'split';
  // A fact's words are its title and are read whole, so they stay in the page rather than being cut
  // into the navigation title; pushed on a phone, the page keeps its Back.
  if (!split) return <NavigationTitleChromeProvider showsTitle={false} showsBack>{props.children}</NavigationTitleChromeProvider>;
  return (
    <NavigationTitleChromeProvider showsTitle={false}>
      <NavigationBackChromeProvider control={null}>{props.children}</NavigationBackChromeProvider>
    </NavigationTitleChromeProvider>
  );
}
