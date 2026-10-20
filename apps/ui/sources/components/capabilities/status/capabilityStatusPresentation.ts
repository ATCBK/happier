import type { IconName } from '@/components/ui/icons/Icon';
import type { StatusPillVariant } from '@/components/ui/status/StatusPill';
import { t } from '@/text';
import { formatAgentNameList } from '../identity/agentNameList';

/** The one owner of capability status words, tone, fix and blocking order (P5 K2, §4.3). */
export type CapabilityStatusKind =
  | 'ready'
  | 'off'
  | 'signin'
  | 'more_access'
  | 'key'
  | 'cantrun'
  | 'offline'
  | 'update'
  | 'modified'
  | 'pinned'
  | 'unused'
  | 'error'
  | 'masked'
  | 'signing'
  | 'connected'
  | 'expired'
  | 'revoked';

export type CapabilityFixKind =
  | 'sign_in'
  | 'reconnect'
  | 'add_key'
  | 'how_to_fix'
  | 'try_again'
  | 'review_update'
  | 'compare'
  | 'turn_on'
  | 'grant_access';

export type CapabilityStatus = Readonly<{
  kind: CapabilityStatusKind;
  /** "on nl2": the machine the status is about, by display name. */
  machineName?: string;
  /**
   * More about the status. A quiet suffix on the pill's line ("· Oct 10", a last-known time) for most kinds; for a
   * stop or a run that cannot happen (`error`, `cantrun`) it is the reason, which the presentation hands on as
   * `reason` so it reads whole on its own line.
   */
  detail?: string;
  fix?: Readonly<{ kind: CapabilityFixKind; onPress: () => void }>;
}>;

export type CapabilityStatusPresentation = Readonly<{
  /** null for 'ready' and other silent states: healthy is quiet. */
  pill: null | Readonly<{
    variant: StatusPillVariant;
    chrome: 'pill' | 'plain';
    leadingIcon?: IconName;
    label: string;
    detail?: string;
  }>;
  /** Why, in words: drawn under the pill, wrapping, never inside it. Only for statuses whose detail is a reason. */
  reason?: string;
  tone: 'needs_you' | 'failed' | 'neutral' | 'quiet';
  /** Higher blocks more; the more blocking status shows when there are two. */
  blockingRank: number;
  fixLabel?: string;
}>;

/** 'row': list rows, composer, legends (the where-summary already says "Off"). 'header': detail headers. */
export type CapabilityStatusPlacement = 'row' | 'header';

type Spec = Readonly<{
  tone: CapabilityStatusPresentation['tone'];
  rank: number;
  /** null: silent at that placement. */
  pill: (
    status: CapabilityStatus,
    placement: CapabilityStatusPlacement,
  ) => null | Readonly<{
    variant: StatusPillVariant;
    chrome: 'pill' | 'plain';
    label: string;
  }>;
  fix?: CapabilityFixKind;
  /** The status's `detail` is a reason (a sentence), not a suffix: it moves under the pill. */
  detailIsReason?: true;
}>;

const needsYou = (label: () => string) => () => ({
  variant: 'attention' as const,
  chrome: 'pill' as const,
  label: label(),
});
const plain = (label: () => string) => () => ({
  variant: 'neutral' as const,
  chrome: 'plain' as const,
  label: label(),
});
const neutral = (label: () => string) => () => ({
  variant: 'neutral' as const,
  chrome: 'pill' as const,
  label: label(),
});

// Blocking order (most first): error > sign-in family > cantrun > offline > update > modified > masked > pinned > off > unused > ready.
const SPECS: Record<CapabilityStatusKind, Spec> = {
  error: {
    tone: 'failed',
    rank: 100,
    fix: 'try_again',
    detailIsReason: true,
    pill: (status) => ({
      variant: 'danger',
      chrome: 'pill',
      label: t('capabilities.status.error', { machine: status.machineName }),
    }),
  },
  signin: {
    tone: 'needs_you',
    rank: 90,
    fix: 'sign_in',
    pill: needsYou(() => t('capabilities.status.signin')),
  },
  more_access: {
    tone: 'needs_you',
    rank: 90,
    fix: 'grant_access',
    pill: needsYou(() => t('capabilities.status.moreAccess')),
  },
  key: {
    tone: 'needs_you',
    rank: 90,
    fix: 'add_key',
    pill: needsYou(() => t('capabilities.status.key')),
  },
  expired: {
    tone: 'needs_you',
    rank: 90,
    fix: 'reconnect',
    pill: needsYou(() => t('capabilities.status.expired')),
  },
  revoked: {
    tone: 'needs_you',
    rank: 90,
    fix: 'reconnect',
    pill: needsYou(() => t('capabilities.status.revoked')),
  },
  cantrun: {
    tone: 'needs_you',
    rank: 80,
    fix: 'how_to_fix',
    detailIsReason: true,
    pill: (status) => ({
      variant: 'attention',
      chrome: 'pill',
      label: t('capabilities.status.cantrun', { machine: status.machineName }),
    }),
  },
  offline: {
    tone: 'neutral',
    rank: 70,
    pill: plain(() => t('capabilities.status.offline')),
  },
  signing: {
    tone: 'neutral',
    rank: 65,
    pill: neutral(() => t('capabilities.status.signing')),
  },
  update: {
    tone: 'neutral',
    rank: 60,
    fix: 'review_update',
    pill: neutral(() => t('capabilities.status.update')),
  },
  modified: {
    tone: 'neutral',
    rank: 50,
    pill: neutral(() => t('capabilities.status.modified')),
  },
  masked: {
    tone: 'neutral',
    rank: 40,
    fix: 'compare',
    pill: (status) => ({
      variant: 'neutral',
      chrome: 'plain',
      label: t('capabilities.status.masked', { machine: status.machineName }),
    }),
  },
  pinned: {
    tone: 'quiet',
    rank: 30,
    pill: plain(() => t('capabilities.status.pinned')),
  },
  off: {
    tone: 'quiet',
    rank: 20,
    fix: 'turn_on',
    pill: (_status, placement) =>
      placement === 'header'
        ? {
            variant: 'neutral',
            chrome: 'plain',
            label: t('capabilities.status.off'),
          }
        : null,
  },
  unused: {
    tone: 'quiet',
    rank: 10,
    pill: plain(() => t('capabilities.status.unused')),
  },
  connected: {
    tone: 'quiet',
    rank: 5,
    pill: (_status, placement) =>
      placement === 'header'
        ? {
            variant: 'neutral',
            chrome: 'plain',
            label: t('capabilities.status.connected'),
          }
        : null,
  },
  ready: { tone: 'quiet', rank: 0, pill: () => null },
};

function fixLabel(kind: CapabilityFixKind): string {
  switch (kind) {
    case 'sign_in':
      return t('capabilities.status.fix.signIn');
    case 'reconnect':
      return t('capabilities.status.fix.reconnect');
    case 'add_key':
      return t('capabilities.status.fix.addKey');
    case 'how_to_fix':
      return t('capabilities.status.fix.howToFix');
    case 'try_again':
      return t('capabilities.status.fix.tryAgain');
    case 'review_update':
      return t('capabilities.status.fix.reviewUpdate');
    case 'compare':
      return t('capabilities.status.fix.compare');
    case 'turn_on':
      return t('capabilities.status.fix.turnOn');
    case 'grant_access':
      return t('capabilities.status.fix.grantAccess');
  }
}

export function presentCapabilityStatus(
  status: CapabilityStatus,
  placement: CapabilityStatusPlacement = 'row',
): CapabilityStatusPresentation {
  const spec = SPECS[status.kind];
  const pill = spec.pill(status, placement);
  const fix = status.fix?.kind ?? spec.fix;
  return {
    pill: pill
      ? { ...pill, ...(status.detail && !spec.detailIsReason ? { detail: status.detail } : {}) }
      : null,
    ...(pill && status.detail && spec.detailIsReason ? { reason: status.detail } : {}),
    tone: spec.tone,
    blockingRank: spec.rank,
    ...(pill && fix ? { fixLabel: fixLabel(fix) } : {}),
  };
}

/** The most blocking status that draws a pill at this placement (silent kinds never win); null when none does. */
export function pickMostBlockingCapabilityStatus(
  statuses: readonly CapabilityStatus[],
  placement: CapabilityStatusPlacement = 'row',
): CapabilityStatus | null {
  let best: CapabilityStatus | null = null;
  let bestRank = -1;
  for (const status of statuses) {
    const presentation = presentCapabilityStatus(status, placement);
    if (!presentation.pill || presentation.blockingRank <= bestRank) continue;
    best = status;
    bestRank = presentation.blockingRank;
  }
  return best;
}

/** Why "Not used recently" can only be known for some Agents (D29), naming the Agents that declare reported use. */
export function explainUnusedCapabilityStatus(
  reportingAgentNames: readonly string[],
): string {
  return t('capabilities.status.unusedExplanation', {
    agents: formatAgentNameList(reportingAgentNames),
  });
}
