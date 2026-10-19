import type {
  PluginChangePendingReviewResult,
  PluginInstallationReview,
} from '@happier-dev/protocol/marketplace/internal';
import { t } from '@/text';

type AuthorityExpansion = Extract<
  PluginChangePendingReviewResult,
  Readonly<{
    kind: 'reviewRequired';
    reviewKind: 'installation';
  }>
>['authorityExpansion'];

/** One titled group of review facts; `lines` is never empty ("None declared" stands in). */
export type PluginInstallationReviewFactSection = Readonly<{
  title: string;
  lines: readonly string[];
}>;

export type PluginInstallationReviewOptionalAccessFact = Readonly<{
  id: string;
  capability: string;
  reason: string;
  scope: string;
}>;

/**
 * The install-and-trust facts a person reads before trusting a plugin, in words. Every surface that
 * presents a `PluginInstallationReview` (the Settings install dialog, an install approval) reads this
 * one owner and lays it out in its own anatomy. A `null` section is not part of this decision (an
 * authority-expansion review shows only the widened access).
 */
export type PluginInstallationReviewFacts = Readonly<{
  identity: PluginInstallationReviewFactSection;
  archiveUrlRetention: string | null;
  trustedCode: PluginInstallationReviewFactSection | null;
  executableCode: PluginInstallationReviewFactSection | null;
  requiredAccess: PluginInstallationReviewFactSection | null;
  optionalAccess: Readonly<{
    title: string;
    entries: readonly PluginInstallationReviewOptionalAccessFact[];
  }> | null;
  requestInterceptors: PluginInstallationReviewFactSection | null;
  rawCredentials: PluginInstallationReviewFactSection | null;
  evidence: PluginInstallationReviewFactSection;
}>;

export type PluginInstallationReviewFactsOptions = Readonly<{
  reason?: 'firstInstall' | 'authorityExpansion';
  currentVersion?: string | null;
  authorityExpansion?: AuthorityExpansion;
}>;

function section(
  title: string,
  lines: readonly string[],
): PluginInstallationReviewFactSection {
  return {
    title,
    lines:
      lines.length > 0
        ? lines
        : [t('settingsPlugins.installReviewSections.none')],
  };
}

/** Declared keys and discriminators read as words ("Fixed origin"); declared values stay as sent. */
function humanizeDeclaredWord(word: string): string {
  const words = word
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : word;
}

function formatScopeScalar(key: string | null, value: unknown): string {
  return (key === 'kind' || key === 'type') &&
    typeof value === 'string' &&
    /^[a-z][A-Za-z0-9_-]*$/.test(value)
    ? humanizeDeclaredWord(value)
    : String(value);
}

const SCOPE_NESTING_INDENT = '  ';

function isScopeScalar(value: unknown): boolean {
    return value === null || typeof value !== 'object';
}

/** A target led by its kind whose other members are plain values reads as one line ("Fixed origin · https://…"). */
function formatKindLedScopeGroup(value: unknown): string | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Readonly<Record<string, unknown>>;
    const discriminator = typeof record.kind === 'string' ? 'kind' : typeof record.type === 'string' ? 'type' : null;
    if (!discriminator) return null;
    const members = Object.entries(record).filter(([key]) => key !== discriminator);
    if (!members.every(([, member]) => isScopeScalar(member))) return null;
    return [formatScopeScalar(discriminator, record[discriminator]), ...members.map(([, member]) => String(member))].join(' · ');
}

function formatScopeValueLines(value: unknown, depth: number): readonly string[] {
    const indent = SCOPE_NESTING_INDENT.repeat(depth);
    if (isScopeScalar(value)) return [`${indent}${String(value)}`];
    const kindLed = formatKindLedScopeGroup(value);
    if (kindLed) return [`${indent}${kindLed}`];
    if (Array.isArray(value)) {
        return value.every(isScopeScalar)
            ? [`${indent}${value.map((entry) => String(entry)).join(', ')}`]
            : value.flatMap((entry) => formatScopeValueLines(entry, depth));
    }
    return Object.entries(value as Readonly<Record<string, unknown>>).flatMap(([key, entry]) => {
        const label = humanizeDeclaredWord(key);
        if (isScopeScalar(entry)) return [`${indent}${label}: ${formatScopeScalar(key, entry)}`];
        if (Array.isArray(entry) && entry.every(isScopeScalar)) return [`${indent}${label}: ${entry.map(String).join(', ')}`];
        const entryKindLed = formatKindLedScopeGroup(entry);
        if (entryKindLed) return [`${indent}${label}: ${entryKindLed}`];
        return [`${indent}${label}:`, ...formatScopeValueLines(entry, depth + 1)];
    });
}

/**
 * Normalized host scope is a bounded plain-data record, so it reads as `Key: value` lines instead of a
 * serialized JSON blob. Nesting renders as indentation; the review schema bounds depth and cardinality.
 */
function formatNormalizedScope(
  scope: Readonly<Record<string, unknown>>,
): string {
  // One fact stays on the label's line; several start beneath it, indented as one block.
  const single = formatScopeValueLines(scope, 0);
  return single.length > 1
    ? `\n${formatScopeValueLines(scope, 1).join('\n')}`
    : single.join('\n');
}

function sourceKindLabel(
  kind: PluginInstallationReview['source']['kind'],
): string {
  if (kind === 'path')
    return t('settingsPlugins.installReviewSections.sourceKind.path');
  if (kind === 'archive')
    return t('settingsPlugins.installReviewSections.sourceKind.archive');
  return t('settingsPlugins.installReviewSections.sourceKind.npm');
}

function marketplaceSourceKindLabel(
  kind: NonNullable<
    Extract<
      PluginInstallationReview['updateChannel'],
      { kind: 'npm' }
    >['marketplaceSource']
  >['kind'],
): string {
  if (kind === 'curated')
    return t(
      'settingsPlugins.installReviewSections.marketplaceSourceKind.curated',
    );
  if (kind === 'community-npm')
    return t(
      'settingsPlugins.installReviewSections.marketplaceSourceKind.community-npm',
    );
  return t('settingsPlugins.installReviewSections.marketplaceSourceKind.user');
}

function executableRealmLabel(
  realm: PluginInstallationReview['executableRealms'][number],
): string {
  if (realm === 'daemon')
    return t('settingsPlugins.installReviewSections.executableRealm.daemon');
  if (realm === 'hostedWeb')
    return t('settingsPlugins.installReviewSections.executableRealm.hostedWeb');
  return t('settingsPlugins.installReviewSections.executableRealm.reactNative');
}

function uiArtifactStatusLabel(
  status: PluginInstallationReview['uiArtifacts']['status'],
): string {
  if (status === 'verified')
    return t('settingsPlugins.installReviewSections.uiArtifactStatus.verified');
  if (status === 'unavailable')
    return t(
      'settingsPlugins.installReviewSections.uiArtifactStatus.unavailable',
    );
  return t('settingsPlugins.installReviewSections.uiArtifactStatus.none');
}

function authorizationClassLabel(
  authorizationClass: PluginInstallationReview['requiredHostAccess'][number]['authorizationClass'],
): string {
  if (authorizationClass === 'cooperativeDisclosure') {
    return t(
      'settingsPlugins.installReviewSections.authorizationClass.cooperativeDisclosure',
    );
  }
  if (authorizationClass === 'presentIntentOrOs') {
    return t(
      'settingsPlugins.installReviewSections.authorizationClass.presentIntentOrOs',
    );
  }
  return t(
    'settingsPlugins.installReviewSections.authorizationClass.hostResourceSelection',
  );
}

function credentialRealmLabel(
  realm: PluginInstallationReview['rawCredentialAccess'][number]['realm'],
): string {
  if (realm === 'web')
    return t('settingsPlugins.installReviewSections.realm.web');
  if (realm === 'ios')
    return t('settingsPlugins.installReviewSections.realm.ios');
  if (realm === 'android')
    return t('settingsPlugins.installReviewSections.realm.android');
  return t('settingsPlugins.installReviewSections.realm.daemon');
}

function credentialPhaseLabel(
  phase: PluginInstallationReview['rawCredentialAccess'][number]['phase'],
): string {
  if (phase === 'settings')
    return t('settingsPlugins.installReviewSections.phase.settings');
  if (phase === 'prepare')
    return t('settingsPlugins.installReviewSections.phase.prepare');
  if (phase === 'speech')
    return t('settingsPlugins.installReviewSections.phase.speech');
  return t('settingsPlugins.installReviewSections.phase.connection');
}

/** Each evidence fact names what it is ("Signature · Not provided"); a bare value says nothing. */
function evidenceLine(label: 'integrity' | 'signature' | 'provenance' | 'curation' | 'happier' | 'publisher', value: string): string {
    return `${t(`settingsPlugins.installReviewSections.evidenceLabel.${label}`)} · ${value}`;
}

function sourceEvidence(review: PluginInstallationReview): readonly string[] {
  const integrity =
    review.source.kind === 'path'
      ? t('common.none')
      : review.source.integrityBasis === 'expected'
        ? t('settingsPlugins.installReviewSections.integrityBasis.expected', {
            integrity: review.source.integrity,
          })
        : t('settingsPlugins.installReviewSections.integrityBasis.observed', {
            integrity: review.source.integrity,
          });
  const signature =
    review.signature.status === 'notProvided'
      ? t('common.notProvided')
      : review.signature.status === 'verified'
        ? t('settingsPlugins.installReviewSections.signatureStatus.verified', {
            keyId: review.signature.keyId,
          })
        : t(
            'settingsPlugins.installReviewSections.signatureStatus.unsupported',
            { keyId: review.signature.keyId },
          );
  const provenance =
    review.provenance.status === 'notProvided'
      ? t('common.notProvided')
      : review.provenance.status === 'declaredUnverified'
        ? t(
            'settingsPlugins.installReviewSections.provenanceDeclaredUnverified',
            {
              predicateType: review.provenance.predicateType,
            },
          )
        : review.provenance.status === 'retrievedUnverified'
          ? t(
              'settingsPlugins.installReviewSections.provenanceRetrievedUnverified',
              {
                predicateTypes: review.provenance.predicateTypes.join(', '),
              },
            )
          : t('settingsPlugins.installReviewSections.provenanceUnavailable', {
              code: review.provenance.code,
            });
  const curation =
    review.curation.status === 'notApplicable'
      ? t('common.notProvided')
      : review.curation.status === 'unreviewed'
        ? t('settingsPlugins.installReviewSections.curationUnreviewed', {
            sourceId: review.curation.sourceId,
          })
        : t('settingsPlugins.installReviewSections.curationApproved', {
            sourceId: review.curation.sourceId,
            reviewedAt: review.curation.reviewedAt,
            reason: review.curation.reason
              ? ` · ${review.curation.reason}`
              : '',
          });
  return [
    evidenceLine('integrity', integrity),
    evidenceLine('signature', signature),
    evidenceLine('provenance', provenance),
    evidenceLine('curation', curation),
  ];
}

/** A path or archive channel that is the very locator the source line names says nothing more. */
function channelRepeatsSource(review: PluginInstallationReview): boolean {
  const channel = review.updateChannel;
  return (
    (channel.kind === 'path' || channel.kind === 'archive') &&
    channel.locator === review.source.locator
  );
}

/** The source, with a development path flagged on the same line rather than repeated beneath it. */
function sourceLine(review: PluginInstallationReview): string {
  const channel = review.updateChannel;
  return t('settingsPlugins.installReviewSections.source', {
    kind: sourceKindLabel(review.source.kind),
    locator:
      channel.kind === 'path' && channel.development && channelRepeatsSource(review)
        ? t('settingsPlugins.installReviewSections.developmentPath', {
            locator: review.source.locator,
          })
        : review.source.locator,
  });
}

function updateChannel(review: PluginInstallationReview): string | null {
  if (channelRepeatsSource(review)) return null;
  if (review.updateChannel.kind === 'path') {
    return review.updateChannel.development
      ? t('settingsPlugins.installReviewSections.developmentPath', {
          locator: review.updateChannel.locator,
        })
      : review.updateChannel.locator;
  }
  if (review.updateChannel.kind === 'archive')
    return review.updateChannel.locator;
  const source = review.updateChannel.marketplaceSource;
  return [
    `${review.updateChannel.packageName} · ${review.updateChannel.registryOrigin}`,
    review.updateChannel.registryProfileId,
    source
      ? t('settingsPlugins.installReviewSections.marketplaceSource', {
          kind: marketplaceSourceKindLabel(source.kind),
          source: `${source.id} · ${source.sourceUrl}`,
        })
      : null,
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join('\n');
}

function credentialRequestLine(
  request: PluginInstallationReview['rawCredentialAccess'][number]['request'],
): string {
  if (request.kind === 'httpHeaders') {
    return t('settingsPlugins.installReviewSections.credentialRequestHeaders', {
      origin: request.origin,
      headers: request.headerNames.join(', '),
    });
  }
  if (request.kind === 'environment') {
    return t(
      'settingsPlugins.installReviewSections.credentialRequestEnvironment',
      {
        keys: request.keys.join(', '),
      },
    );
  }
  return t('settingsPlugins.installReviewSections.credentialRequestFiles', {
    files: request.fileIds.join(', '),
  });
}

function credentialSourceLines(
  entry: PluginInstallationReview['rawCredentialAccess'][number],
): readonly string[] {
  const sourceLines =
    entry.sourceClass.kind === 'savedSecret'
      ? [
          t('settingsPlugins.installReviewSections.savedSecret'),
          t('settingsPlugins.installReviewSections.secretKinds', {
            kinds: entry.sourceClass.secretKinds.join(', '),
          }),
        ]
      : [
          t('settingsPlugins.installReviewSections.connectedAccount'),
          t('settingsPlugins.installReviewSections.connectedAccountService', {
            service: `${entry.sourceClass.service.pluginId}/${entry.sourceClass.service.localId}`,
          }),
        ];
  return [
    `${entry.contribution.pluginId}/${entry.contribution.localId} · ${entry.credentialSlot.title}`,
    ...sourceLines,
    t('settingsPlugins.installReviewSections.credentialPurpose', {
      purpose: entry.credentialSlot.purpose,
    }),
    t('settingsPlugins.installReviewSections.credentialUse', {
      realm: credentialRealmLabel(entry.realm),
      phase: credentialPhaseLabel(entry.phase),
    }),
    t('settingsPlugins.installReviewSections.credentialAccess', {
      access: credentialRequestLine(entry.request),
    }),
  ];
}

export function describePluginInstallationReviewFacts(
  review: PluginInstallationReview,
  options: PluginInstallationReviewFactsOptions = {},
): PluginInstallationReviewFacts {
  const isAuthorityExpansion = options.reason === 'authorityExpansion';
  const expansion = new Set(options.authorityExpansion ?? []);
  // Code changes of already-trusted plugins never reopen review, so a delta-only decision shows
  // only the widened access.
  const showsRequiredAccess =
    !isAuthorityExpansion ||
    expansion.has('requiredHostAccess') ||
    expansion.has('connectedAccountPurpose');
  const showsOptionalAccess =
    !isAuthorityExpansion || expansion.has('selectedOptionalHostAccess');
  const showsRequestInterceptors =
    !isAuthorityExpansion || expansion.has('requestInterceptor');
  const showsRawCredentials =
    !isAuthorityExpansion || expansion.has('rawCredentialAccess');
  const scopeLine = (scope: Readonly<Record<string, unknown>>) =>
    t('settingsPlugins.installReviewSections.scope', {
      scope: formatNormalizedScope(scope),
    });
  return {
    identity: section(t('settingsPlugins.installReviewSections.identity'), [
      `${review.displayName} · ${review.version}`,
      ...(isAuthorityExpansion && options.currentVersion
        ? [`${options.currentVersion} → ${review.version}`]
        : []),
      sourceLine(review),
      ...(updateChannel(review) ?? []),
      evidenceLine(
        'publisher',
        review.publisherIdentity.status === 'unavailable'
          ? t('common.unavailable')
          : t('settingsPlugins.installReviewSections.publisherUnverified', {
              displayName: review.publisherIdentity.displayName,
              id: review.publisherIdentity.id,
            }),
      ),
    ]),
    archiveUrlRetention:
      review.source.kind === 'archive' &&
      /^https?:\/\//u.test(review.source.locator)
        ? t('settingsPlugins.installReviewSections.archiveUrlRetention')
        : null,
    trustedCode: isAuthorityExpansion
      ? null
      : section(t('settingsPlugins.installReviewSections.trustedCodeTitle'), [
          t('settingsPlugins.installReviewSections.trustedCodeDisclosure'),
        ]),
    executableCode: isAuthorityExpansion
      ? null
      : section(t('settingsPlugins.installReviewSections.executableCode'), [
          ...review.executableRealms.map(executableRealmLabel),
          ...review.contributions.map(
            (entry) => `${humanizeDeclaredWord(entry.family)} · ${entry.count}`,
          ),
          review.uiArtifacts.contributionIds.length > 0
            ? t('settingsPlugins.installReviewSections.uiArtifacts', {
                status: uiArtifactStatusLabel(review.uiArtifacts.status),
                ids: review.uiArtifacts.contributionIds.join(', '),
              })
            : uiArtifactStatusLabel(review.uiArtifacts.status),
        ]),
    requiredAccess: showsRequiredAccess
      ? section(
          t('settingsPlugins.installReviewSections.requiredAccess'),
          review.requiredHostAccess.map(
            (entry) =>
              `${entry.capability} · ${authorizationClassLabel(entry.authorizationClass)}\n${entry.reason}\n${scopeLine(entry.normalizedScope)}`,
          ),
        )
      : null,
    optionalAccess: showsOptionalAccess
      ? {
          title: t('settingsPlugins.installReviewSections.optionalAccess'),
          entries: review.optionalHostAccess.map((entry) => ({
            id: entry.id,
            capability: entry.capability,
            reason: entry.reason,
            scope: scopeLine(entry.normalizedScope),
          })),
        }
      : null,
    requestInterceptors: showsRequestInterceptors
      ? section(
          t('settingsPlugins.installReviewSections.requestInterceptors'),
          review.requestInterceptors.map(
            (entry) =>
              `${entry.id}\n${entry.origins.join(', ')}\n${entry.methods?.join(', ') ?? t('common.all')} · ${t('settingsPlugins.installReviewSections.priority', { priority: entry.priority })}`,
          ),
        )
      : null,
    rawCredentials: showsRawCredentials
      ? section(
          t('settingsPlugins.installReviewSections.rawCredentials'),
          review.rawCredentialAccess.flatMap(credentialSourceLines),
        )
      : null,
    evidence: section(t('settingsPlugins.installReviewSections.evidence'), [
      ...sourceEvidence(review),
      evidenceLine('happier', review.compatibility.happier ?? t('common.notProvided')),
      t('settingsPlugins.installReviewSections.runtimeApi', {
        version: review.compatibility.runtimeApiVersion,
      }),
      ...(review.compatibility.blockedNewerVersions ?? []).map(
        (entry) =>
          `${entry.version}: ${entry.diagnostics.map((diagnostic) => diagnostic.message).join('; ')}`,
      ),
    ]),
  };
}

/**
 * The read-only order of the same facts, for a surface that lists them (an install approval). Optional
 * access reads as one section here because a read-only surface does not choose it.
 */
export function listPluginInstallationReviewFactSections(
  facts: PluginInstallationReviewFacts,
): readonly Readonly<{ id: string } & PluginInstallationReviewFactSection>[] {
  const optional =
    facts.optionalAccess && facts.optionalAccess.entries.length > 0
      ? section(
          facts.optionalAccess.title,
          facts.optionalAccess.entries.map(
            (entry) => `${entry.capability}\n${entry.reason}\n${entry.scope}`,
          ),
        )
      : null;
  return (
    [
      ['identity', facts.identity],
      ['archiveUrlRetention', null],
      ['trustedCode', facts.trustedCode],
      ['executableCode', facts.executableCode],
      ['requiredAccess', facts.requiredAccess],
      ['optionalAccess', optional],
      ['requestInterceptors', facts.requestInterceptors],
      ['rawCredentials', facts.rawCredentials],
      ['evidence', facts.evidence],
    ] as const
  ).flatMap(([id, value]) => (value ? [{ id, ...value }] : []));
}
