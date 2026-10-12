import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';

export type ProcessConfirmFact = Readonly<{
  label: string;
  value: string;
  mono?: boolean;
}>;

/** What a fresh identity check found (`machines.processes.check`): it decides whether the kill may go ahead. */
export type ProcessRecheck = Readonly<
  ({ kind: 'same'; line: string } | { kind: 'blocked'; line: string }) & {
    /** The evidence the fresh read carries, when the dialog opened without it. */
    evidence?: Readonly<{ title: string; detail: string }> | null;
  }
>;

export type ProcessConfirmContent = Readonly<{
  /** The question, naming the thing ("Kill the type checker?"). */
  title: string;
  /** The consequence in words, one paragraph each. */
  paragraphs: readonly string[];
  facts: readonly ProcessConfirmFact[];
  /** The one piece of evidence the decision rests on (Ask first · likely). */
  evidence?: Readonly<{ title: string; detail: string }> | null;
  /** A fresh pid + start check, run while the dialog is open; the destructive button waits for it. */
  recheck?: () => Promise<ProcessRecheck>;
  /** A quiet line beside the buttons when there is no re-check ("Happier never does this on its own."). */
  note?: string;
  /** The gentler way ("Stop session instead"). */
  alternative?: string;
  confirmLabel: string;
  testID: string;
}>;

export type ProcessConfirmDecision = 'confirm' | 'alternative' | null;

type DialogProps = CustomModalInjectedProps &
  Readonly<{
    content: ProcessConfirmContent;
    onResolve: (decision: ProcessConfirmDecision) => void;
  }>;

/**
 * The destructive pattern (lab `rp` KF): a question that names the thing, the consequence in words, the facts
 * it rests on, Cancel, then one destructive button. Anything not proven Happier's is checked again while the
 * dialog is open, and the line says what that check found; a changed or vanished process cannot be killed.
 */
function ProcessConfirmDialog(props: DialogProps) {
  const { theme } = useUnistyles();
  const { content, onResolve, onClose } = props;
  const [recheck, setRecheck] = React.useState<
    ProcessRecheck | 'checking' | null
  >(content.recheck ? 'checking' : null);
  React.useEffect(() => {
    if (!content.recheck) return;
    let live = true;
    content.recheck().then(
      (result) => {
        if (live) setRecheck(result);
      },
      () => {
        if (live)
          setRecheck({
            kind: 'blocked',
            line: t('machineProcesses.kill.recheckedChanged'),
          });
      },
    );
    return () => {
      live = false;
    };
  }, [content]);
  const resolve = React.useCallback(
    (decision: ProcessConfirmDecision) => {
      onResolve(decision);
      onClose();
    },
    [onClose, onResolve],
  );
  const blocked =
    recheck === 'checking' || (recheck !== null && recheck.kind === 'blocked');
  const evidence = content.evidence ?? (recheck !== null && recheck !== 'checking' ? recheck.evidence ?? null : null);
  const note =
    recheck === 'checking'
      ? t('machineProcesses.kill.checking')
      : (recheck?.line ?? content.note ?? null);
  return (
    <View testID={content.testID} style={styles.body}>
      {content.paragraphs.map((paragraph) => (
        <Text key={paragraph} style={styles.paragraph}>
          {paragraph}
        </Text>
      ))}
      {content.facts.length > 0 ? (
        <ItemGroup header="none">
          {content.facts.map((fact) => (
            <Item
              key={fact.label}
              title={fact.label}
              detail={fact.value}
              mode="info"
              showChevron={false}
              density="compact"
              {...(fact.mono ? { detailStyle: styles.mono } : {})}
            />
          ))}
        </ItemGroup>
      ) : null}
      {evidence ? (
        <View style={styles.evidence}>
          <Icon name="check" size={14} color={theme.colors.text.primary} />
          <View style={styles.evidenceText}>
            <Text style={styles.evidenceTitle}>{evidence.title}</Text>
            <Text style={styles.paragraph}>{evidence.detail}</Text>
          </View>
        </View>
      ) : null}
      <View style={styles.footer}>
        <View style={styles.footerLead}>
          {content.alternative ? (
            <TextLinkButton
              testID={`${content.testID}-alternative`}
              label={content.alternative}
              tone="strong"
              onPress={() => resolve('alternative')}
            />
          ) : note ? (
            <Text
              testID={`${content.testID}-note`}
              accessibilityLiveRegion="polite"
              style={styles.note}
            >
              {note}
            </Text>
          ) : null}
        </View>
        <RoundButton
          testID={`${content.testID}-cancel`}
          size="normal"
          display="secondary"
          title={t('common.cancel')}
          onPress={() => resolve(null)}
        />
        <RoundButton
          testID={`${content.testID}-confirm`}
          size="normal"
          display="destructive"
          title={content.confirmLabel}
          disabled={blocked}
          onPress={() => resolve('confirm')}
        />
      </View>
      {content.alternative && note ? (
        <Text
          testID={`${content.testID}-note`}
          accessibilityLiveRegion="polite"
          style={styles.note}
        >
          {note}
        </Text>
      ) : null}
    </View>
  );
}

/** Open the confirmation; resolves to the person's decision, `null` for every way of backing out. */
export function showProcessConfirmDialog(
  content: ProcessConfirmContent,
): Promise<ProcessConfirmDecision> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (decision: ProcessConfirmDecision) => {
      if (!settled) {
        settled = true;
        resolve(decision);
      }
    };
    Modal.show({
      component: ProcessConfirmDialog,
      props: { content, onResolve: settle },
      onRequestClose: () => settle(null),
      chrome: {
        kind: 'card',
        title: content.title,
        testID: `${content.testID}-modal`,
        phonePresentation: 'sheet',
        dimensions: { width: 460, maxHeightRatio: 0.86, size: 'md' },
      },
      closeOnBackdrop: true,
    });
  });
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.space.s12,
    paddingBottom: theme.space.s4,
  },
  paragraph: {
    ...Typography.default(),
    color: theme.colors.text.secondary,
  },
  mono: {
    ...Typography.mono(),
  },
  evidence: {
    flexDirection: 'row',
    gap: theme.space.s8,
    alignItems: 'flex-start',
  },
  evidenceText: {
    flex: 1,
    gap: theme.space.s2,
  },
  evidenceTitle: {
    ...Typography.default('medium'),
    color: theme.colors.text.primary,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    marginTop: theme.space.s4,
  },
  footerLead: {
    flex: 1,
    minWidth: 0,
  },
  note: {
    ...Typography.rowMeta(),
    color: theme.colors.text.tertiary,
  },
}));
