import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import type { NewSessionInstructionsCreationModel } from '@/components/sessions/new/hooks/newSessionScreenModelTypes';
import { AttachExistingInstructions } from '@/components/sessions/work/instructions/SessionInstructionsSection';
import { promptCollectionItemHref } from '@/components/settings/prompts/collection/promptCollectionModel';
import {
  promptStackEntryTitle,
  usePromptStackEntryPresentations,
} from '@/components/settings/prompts/stacks/promptStackEntryPresentation';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Icon } from '@/components/ui/icons/Icon';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/** `creating` is the Create request in flight; `pending` is a document create waiting for approval. */
type CreateState = 'idle' | 'creating' | 'pending' | 'failed';

/** One primitive snapshot of the draft's Instructions, so the leaf re-renders on change, never on identity. */
function readInstructionsSnapshot(
  creation: NewSessionInstructionsCreationModel,
): string {
  const ref = creation.getEntry()?.ref;
  return JSON.stringify([
    ref?.serverId ?? null,
    ref?.artifactId ?? null,
    creation.getDraft() !== null,
    creation.getApprovalPending(),
  ]);
}

/**
 * Instructions before the first input (plan 60 §2, 61 I61-1; the same two choices as Work › Instructions,
 * lab `b-work S1`): above the composer, Create instructions makes a real Prompt Library document through
 * the draft's own Save and opens it in the Prompt Library editor; Attach existing picks one from the
 * library. Either way the draft carries the qualified reference into the spawn before the first input.
 * Attached, the row names the document with Edit and Detach. A New bot draft offers the choice; an
 * ordinary draft shows the row only once it carries Instructions. A Create that doesn't land keeps the
 * authored draft (Send still creates it) and says so; Create again retries it.
 */
export const NewSessionInstructions = React.memo(
  function NewSessionInstructions(
    props: Readonly<{
      creation: NewSessionInstructionsCreationModel;
      serverId: string;
      /** A New bot draft invites Instructions; other drafts only show ones they already carry. */
      invite: boolean;
      /** The draft's name, read at Create time: the new document is titled after it. */
      getName: () => string;
    }>,
  ) {
    const { creation, serverId, getName } = props;
    const styles = stylesheet;
    const router = useRouter();
    const subscribe = creation.subscribe;
    const snapshot = React.useCallback(
      () => readInstructionsSnapshot(creation),
      [creation],
    );
    React.useSyncExternalStore(subscribe, snapshot, snapshot);
    const entry = creation.getEntry();
    const retained = entry === null && creation.getDraft() !== null;
    const [createState, setCreateState] = React.useState<CreateState>('idle');
    const mounted = React.useRef(true);
    React.useEffect(() => {
      mounted.current = true;
      return () => { mounted.current = false; };
    }, []);

    const create = React.useCallback(async () => {
      setCreateState('creating');
      // A retry reuses the retained draft; a first Create starts an empty document under the draft's name.
      if (!creation.getDraft()) {
        creation.onDraftChange({
          title: getName().trim() || t('sessionInstructions.title'),
          markdown: '',
        });
      }
      // A thrown Save is a Create that didn't land: the retained draft and the failed line say so.
      const created = await creation.saveDraft().catch(() => null);
      if (!mounted.current) return;
      const ref = created?.createdRef ?? null;
      if (ref) {
        setCreateState('idle');
        const currentRef = creation.getEntry()?.ref;
        // A newer choice or authored body stays on screen, even though this document is reusable.
        if (creation.getDraft() !== null || currentRef?.artifactId !== ref.artifactId || currentRef.serverId !== ref.serverId) return;
        router.push(
          promptCollectionItemHref('doc', ref.artifactId, {
            serverId: ref.serverId ?? serverId,
          }) as never,
        );
        return;
      }
      const awaitingApproval =
        created?.result.ok === true &&
        ActionApprovalRequestCreatedResultSchema.safeParse(
          created.result.result,
        ).success;
      setCreateState(creation.getDraft() === null ? 'idle' : awaitingApproval ? 'pending' : 'failed');
    }, [creation, getName, router, serverId]);
    const edit = React.useCallback(() => {
      if (!entry) return;
      router.push(
        promptCollectionItemHref('doc', entry.ref.artifactId, {
          serverId: entry.ref.serverId ?? serverId,
        }) as never,
      );
    }, [entry, router, serverId]);
    const detach = React.useCallback(() => {
      setCreateState('idle');
      creation.selectReference(null);
    }, [creation]);
    const attach = React.useCallback<
      NewSessionInstructionsCreationModel['selectReference']
    >(
      (ref) => {
        setCreateState('idle');
        creation.selectReference(ref);
      },
      [creation],
    );

    if (!entry && !retained && !props.invite) return null;
    const failed =
      createState === 'failed' || (createState === 'idle' && retained);
    return (
      <View testID="new-session-instructions" style={styles.root}>
        {createState === 'pending' || creation.getApprovalPending() ? (
          <SurfaceFreshnessLine
            testID="new-session-instructions.pending"
            busy
            reason={t('sessionInstructions.savePending')}
          />
        ) : failed ? (
          <SurfaceFreshnessLine
            testID="new-session-instructions.failed"
            tone="warning"
            reason={t('bots.create.documentFailed')}
          />
        ) : null}
        {entry ? (
          <View style={styles.row}>
            <Text style={styles.label}>{t('sessionInstructions.title')}</Text>
            <AttachedInstructions
              entry={entry}
              serverId={serverId}
              onEdit={edit}
              onDetach={detach}
            />
          </View>
        ) : (
          // Two operations written on the purpose's line, not a pair of buttons that reads as a toggle.
          <View style={styles.row}>
            <TextLinkButton
              testID="new-session-instructions-create"
              tone="strong"
              label={t('sessionInstructions.create')}
              onPress={create}
              disabled={createState === 'creating'}
            />
            <Text style={styles.separator} aria-hidden>·</Text>
            <AttachExistingInstructions
              testID="new-session-instructions-attach"
              serverId={serverId}
              title={t('sessionInstructions.attach')}
              quiet
              link
              onAttach={attach}
            />
          </View>
        )}
      </View>
    );
  },
);

/** The attached document by its Prompt Library title, with Edit (the library editor) and Detach. */
function AttachedInstructions(
  props: Readonly<{
    entry: PromptStackEntryV1;
    serverId: string;
    onEdit: () => void;
    onDetach: () => void;
  }>,
) {
  const styles = stylesheet;
  const { theme } = useUnistyles();
  const entries = React.useMemo(() => [props.entry], [props.entry]);
  const presentations = usePromptStackEntryPresentations(
    entries,
    props.serverId,
  );
  return (
    <View testID="new-session-instructions.attached" style={styles.attached}>
      <Icon name="file-text" size={16} color={theme.colors.text.secondary} />
      <Text style={styles.document} numberOfLines={1}>
        {promptStackEntryTitle(props.entry, presentations)}
      </Text>
      <IconButton
        testID="new-session-instructions-edit"
        iconName="pencil-simple"
        variant="plain"
        accessibilityLabel={t('sessionInstructions.edit')}
        tooltip={t('sessionInstructions.edit')}
        onPress={props.onEdit}
      />
      <IconButton
        testID="new-session-instructions-detach"
        iconName="x"
        variant="plain"
        accessibilityLabel={t('sessionInstructions.detach')}
        tooltip={t('sessionInstructions.detachHelp')}
        onPress={props.onDetach}
      />
    </View>
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  // The host places the line: under a Bot's name, or on the composer's edge above the card.
  root: {
    gap: theme.space.s6,
  },
  // One line height in every state, so choosing or detaching never moves the composer below.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    // A wrapping row packs its lines at the top; centre them so text sits mid-line in every state.
    alignContent: 'center',
    columnGap: theme.space.s8,
    rowGap: theme.space.s6,
    minHeight: 28,
  },
  separator: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.tertiary,
  },
  label: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.secondary,
  },
  attached: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    flexShrink: 1,
    minWidth: 0,
  },
  document: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.primary,
    flexShrink: 1,
    minWidth: 0,
  },
}));
