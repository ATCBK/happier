import type { ReactElement, ReactNode } from 'react';

import {
  buildHappierCapabilityCollectionAnatomy,
  type HappierCapabilityCollectionAnatomyInput,
} from '../presentation/capabilities/capabilityCollectionAnatomy.js';
import {
  HappierCapabilityFacts,
  buildHappierCapabilityFacts,
  buildHappierCapabilityHeaderFacts,
  type HappierCapabilityCost,
  type HappierCapabilityFactGlyph,
  type HappierCapabilityFactsInput,
  type HappierCapabilityFactsLabels,
  type HappierCapabilityFactsTextProps,
  type HappierCapabilitySource,
  type HappierCapabilityTrust,
} from '../presentation/capabilities/capabilityFacts.js';
import {
  doesHappierCapabilityStatusSpeak,
  resolveHappierCapabilityBlockingNotice,
  type HappierCapabilityFixKind,
  type HappierCapabilityStatus,
  type HappierCapabilityStatusKind,
  type HappierCapabilityStatusLabels,
  type HappierCapabilityStatusPlacement,
} from '../presentation/capabilities/capabilityStatus.js';
import {
  HappierCapabilityStatusChip,
  type HappierCapabilityStatusFixProps,
  type HappierCapabilityStatusPillProps,
} from '../presentation/capabilities/CapabilityStatusChip.js';
import { Button } from './Button.js';
import type { CollectionAnatomy } from './Collection.js';
import { Badge, Banner } from './Foundation.js';
import { Icon, type IconName } from './Icon.js';
import { PageHeader } from './PageHeader.js';
import {
  usePluginTranslation,
  type PluginTranslate,
} from './PluginUiProvider.js';
import { Text } from './Text.js';

/**
 * Capability kit for plugins that manage installable things (skills, servers, agents, extensions): the same
 * status words and blocking order, facts line, detail header, blocking notice and list-row anatomy Happier's own
 * Skills, MCP and Agents pages use, from one shared owner. The author passes data and handlers; the words come
 * from Happier's defaults or the plugin's translation bundle (`happier.plugin-ui.capability.*`).
 */

export type CapabilityStatusKind = HappierCapabilityStatusKind;
export type CapabilityFixKind = HappierCapabilityFixKind;
export type CapabilityStatus = HappierCapabilityStatus;
export type CapabilityStatusPlacement = HappierCapabilityStatusPlacement;
export type CapabilitySource = HappierCapabilitySource;
export type CapabilityTrust = HappierCapabilityTrust;
export type CapabilityCost = HappierCapabilityCost;
export type CapabilityFactsInput = HappierCapabilityFactsInput;


const KEY = 'happier.plugin-ui.capability';

function statusLabels(
  translate: PluginTranslate,
): HappierCapabilityStatusLabels {
  return {
    status: (kind, machine) => {
      switch (kind) {
        case 'error':
          return machine
            ? translate(`${KEY}.status.errorOn`, `Stopped on ${machine}`, { machine })
            : translate(`${KEY}.status.error`, 'Couldn’t start');
        case 'cantrun':
          return machine
            ? translate(
                `${KEY}.status.cantrunOn`,
                `Can’t run on ${machine}`,
                { machine },
              )
            : translate(`${KEY}.status.cantrun`, 'Can’t run');
        case 'masked':
          return machine
            ? translate(`${KEY}.status.maskedOn`, `${machine}’s copy wins`, { machine })
            : translate(`${KEY}.status.masked`, 'Another copy wins');
        case 'signin':
          return translate(`${KEY}.status.signin`, 'Needs sign-in');
        case 'more_access':
          return translate(`${KEY}.status.moreAccess`, 'Needs more access');
        case 'key':
          return translate(`${KEY}.status.key`, 'Needs a key');
        case 'expired':
          return translate(`${KEY}.status.expired`, 'Sign-in expired');
        case 'revoked':
          return translate(`${KEY}.status.revoked`, 'Access revoked');
        case 'offline':
          return translate(`${KEY}.status.offline`, 'Offline');
        case 'signing':
          return translate(`${KEY}.status.signing`, 'Signing in…');
        case 'update':
          return translate(`${KEY}.status.update`, 'Update available');
        case 'modified':
          return translate(`${KEY}.status.modified`, 'Modified');
        case 'pinned':
          return translate(`${KEY}.status.pinned`, 'Pinned');
        case 'off':
          return translate(`${KEY}.status.off`, 'Off');
        case 'unused':
          return translate(`${KEY}.status.unused`, 'Not used recently');
        case 'connected':
          return translate(`${KEY}.status.connected`, 'Connected');
      }
    },
    fix: (kind) => {
      switch (kind) {
        case 'sign_in':
          return translate(`${KEY}.fix.signIn`, 'Sign in');
        case 'reconnect':
          return translate(`${KEY}.fix.reconnect`, 'Reconnect');
        case 'add_key':
          return translate(`${KEY}.fix.addKey`, 'Add a key');
        case 'how_to_fix':
          return translate(`${KEY}.fix.howToFix`, 'How to fix');
        case 'try_again':
          return translate(`${KEY}.fix.tryAgain`, 'Try again');
        case 'review_update':
          return translate(`${KEY}.fix.reviewUpdate`, 'Review update');
        case 'compare':
          return translate(`${KEY}.fix.compare`, 'Compare');
        case 'turn_on':
          return translate(`${KEY}.fix.turnOn`, 'Turn on');
        case 'grant_access':
          return translate(`${KEY}.fix.grantAccess`, 'Grant access');
      }
    },
  };
}

function factsLabels(translate: PluginTranslate): HappierCapabilityFactsLabels {
  return {
    you: () => translate(`${KEY}.facts.you`, 'You'),
    happier: () => translate(`${KEY}.facts.happier`, 'Happier'),
    trust: (trust) =>
      trust === 'runs_scripts'
        ? translate(`${KEY}.facts.runsScripts`, 'Runs scripts')
        : trust === 'has_files'
          ? translate(`${KEY}.facts.hasFiles`, 'Has files')
          : translate(`${KEY}.facts.textOnly`, 'Text only'),
    toolCount: (count, shown) =>
      count === 1
        ? translate(`${KEY}.facts.tool`, `${shown} tool`, { count: shown })
        : translate(`${KEY}.facts.tools`, `${shown} tools`, { count: shown }),
    tokensPerTurn: (shown) =>
      translate(`${KEY}.facts.tokensPerTurn`, `${shown} tokens a turn`, {
        count: shown,
      }),
    tokensWhenUsed: (shown) =>
      translate(`${KEY}.facts.tokensWhenUsed`, `${shown} tokens`, {
        count: shown,
      }),
  };
}

/** The public icon vocabulary's nearest glyph for each fact. */
const GLYPH_ICON: Readonly<Record<HappierCapabilityFactGlyph, IconName>> = {
  you: 'settings',
  git: 'change-open',
  machine: 'desktop',
  link: 'globe',
  text_only: 'file',
  has_files: 'file',
  runs_scripts: 'terminal',
};

function StatusPill(props: HappierCapabilityStatusPillProps): ReactElement {
  const label =
    props.detail === undefined
      ? props.label
      : `${props.label} · ${props.detail}`;
  if (props.chrome === 'plain')
    return (
      <Text variant="meta" tone="secondary" numberOfLines={1}>
        {label}
      </Text>
    );
  return (
    <Badge
      tone={props.variant}
      variant={props.variant === 'neutral' ? 'outlined' : 'tinted'}
    >
      {label}
    </Badge>
  );
}

function StatusFix(props: HappierCapabilityStatusFixProps): ReactElement {
  return (
    <Button
      variant="secondary"
      size="small"
      title={props.title}
      onPress={props.onPress}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
    />
  );
}

function StatusReason(props: Readonly<{ children: string }>): ReactElement {
  return (
    <Text variant="meta" tone="secondary">
      {props.children}
    </Text>
  );
}

export type CapabilityStatusChipProps = Readonly<{
  status: CapabilityStatus;
  /** `row` (default) for lists; `header` for a detail header, where `off` and `connected` also speak. */
  placement?: CapabilityStatusPlacement;
  /** Draw the status's one fix (its `fix.onPress`) beside it; in a list the row's own action usually holds it. */
  showFix?: boolean;
  testID?: string;
}>;

/** A capability's status where it speaks; healthy statuses draw nothing. */
export function CapabilityStatusChip(
  props: CapabilityStatusChipProps,
): ReactElement | null {
  const translate = usePluginTranslation();
  return (
    <HappierCapabilityStatusChip
      {...props}
      labels={statusLabels(translate)}
      Pill={StatusPill}
      Fix={StatusFix}
      Reason={StatusReason}
    />
  );
}

function FactsText(props: HappierCapabilityFactsTextProps): ReactElement {
  return (
    <Text
      variant={props.mono === true ? 'code' : 'meta'}
      tone={props.strong === true ? 'secondary' : 'muted'}
      {...(props.numberOfLines === undefined
        ? {}
        : { numberOfLines: props.numberOfLines })}
    >
      {props.children}
    </Text>
  );
}

export type CapabilityFactsProps = CapabilityFactsInput &
  Readonly<{ testID?: string }>;

/** Source · trust · cost on one quiet line that truncates at its end ("Runs scripts" carries weight). */
export function CapabilityFacts({
  testID,
  ...input
}: CapabilityFactsProps): ReactElement | null {
  const translate = usePluginTranslation();
  return (
    <HappierCapabilityFacts
      facts={buildHappierCapabilityFacts(input, factsLabels(translate))}
      Text={FactsText}
      renderGlyph={(glyph) => (
        <Icon name={GLYPH_ICON[glyph]} size="small" tone="muted" />
      )}
      {...(testID === undefined ? {} : { testID })}
    />
  );
}

export type CapabilityDetailHeaderProps = Readonly<{
  title: string;
  /** What it is for, from its own text; stops at two lines. */
  purpose?: string;
  /** Its identity mark (an `Image` or `BrandMark`); omit for kinds without one. */
  mark?: ReactNode;
  facts: CapabilityFactsInput;
  status?: CapabilityStatus | null;
  /** An identifier after the facts, drawn in mono (a registry id). */
  mono?: string;
  /** At most one primary page action plus a menu of rare operations. */
  actions?: ReactNode;
  testID: string;
}>;

/**
 * A capability's detail header: its mark, name and purpose, the facts that distinguish it on the meta line,
 * and a header-placement status only when it says something.
 */
export function CapabilityDetailHeader(
  props: CapabilityDetailHeaderProps,
): ReactElement {
  const translate = usePluginTranslation();
  const facts = buildHappierCapabilityHeaderFacts(
    props.facts,
    factsLabels(translate),
  );
  const meta = [
    ...facts.map((fact) => ({
      key: fact.key,
      text: fact.text,
      ...(fact.glyph === undefined ? {} : { icon: GLYPH_ICON[fact.glyph] }),
    })),
    ...(props.mono ? [{ key: 'mono', text: props.mono }] : []),
  ];
  const status = props.status ?? null;
  return (
    <PageHeader
      title={props.title}
      {...(props.purpose === undefined ? {} : { description: props.purpose })}
      {...(props.mark === undefined ? {} : { leading: props.mark })}
      meta={meta}
      {...(status !== null && doesHappierCapabilityStatusSpeak(status, 'header')
        ? {
            details: (
              <CapabilityStatusChip
                status={status}
                placement="header"
                testID={`${props.testID}.status`}
              />
            ),
          }
        : {})}
      {...(props.actions === undefined ? {} : { actions: props.actions })}
      testID={props.testID}
    />
  );
}

export type CapabilityBlockingBannerProps = Readonly<{
  status: CapabilityStatus;
  /** What stopped working ("Linear is signed out"). */
  title: string;
  /** What that means for the person's sessions. */
  body: string;
  testID?: string;
}>;

/** The one notice a blocked capability page leads with, with its fix; nothing for a status that does not block. */
export function CapabilityBlockingBanner(
  props: CapabilityBlockingBannerProps,
): ReactElement | null {
  const translate = usePluginTranslation();
  const notice = resolveHappierCapabilityBlockingNotice(
    props.status,
    statusLabels(translate),
  );
  if (notice === null) return null;
  return (
    <Banner
      tone={notice.tone}
      title={props.title}
      description={props.body}
      {...(notice.action === null
        ? {}
        : {
            action: (
              <Button
                variant={
                  notice.action.display === 'secondary'
                    ? 'secondary'
                    : 'primary'
                }
                size="small"
                title={notice.action.label}
                onPress={notice.action.onPress}
              />
            ),
          })}
      testID={props.testID ?? 'capability.banner'}
    />
  );
}

export type CapabilityCollectionAnatomyInput<Item> =
  HappierCapabilityCollectionAnatomyInput<Item>;

const COLLECTION_PARTS = {
  facts: (facts: CapabilityFactsInput) => <CapabilityFacts {...facts} />,
  status: (status: CapabilityStatus, testID: string) => (
    <CapabilityStatusChip status={status} testID={testID} />
  ),
  summary: (summary: string) => (
    <Text variant="meta" tone="secondary" numberOfLines={1}>
      {summary}
    </Text>
  ),
} as const;

/**
 * The capability row anatomy for `Collection`: name with where it is on at the title line's end, description,
 * then the facts line, which a speaking status takes.
 */
export function capabilityCollectionAnatomy<Item>(
  input: CapabilityCollectionAnatomyInput<Item>,
): CollectionAnatomy<Item> {
  return buildHappierCapabilityCollectionAnatomy(input, COLLECTION_PARTS);
}
