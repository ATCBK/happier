import { stat } from 'node:fs/promises';

import type { RunnerLaunchManifestV1 } from '@happier-dev/protocol/ephemeralRunner/launchManifest';
import type { RunnerArtifactIdentityV1 } from '@happier-dev/protocol/ephemeralRunner/runnerArtifact';
import type { PluginInstallationReview } from '@happier-dev/protocol/marketplace/internal';

import type { PluginRegistryProfileRequirement } from '@/plugins/daemon/changeContract';

import { promptInput, promptSecretInput, isInteractiveTerminal } from '@/terminal/prompts/promptInput';
import { promptMultipleChoice } from '@/terminal/prompts/promptMultipleChoice';
import { resolveAbsolutePathFromWorkingDirectory } from '@/utils/path/expandHomeDirPath';

import type {
  EphemeralRunnerEndpointFailure,
  EphemeralRunnerEndpointPhase,
  EphemeralRunnerEndpointSnapshot,
  EphemeralRunnerEndpointUi,
  VerifiedEphemeralRunnerReview,
} from './controlPlane';
import {
  EphemeralRunnerNativeDirectoryPickerUnavailableError,
  selectDirectoryWithNativeDialog,
  type NativeDirectoryPickerResult,
} from './nativeDirectoryPicker';

export type EphemeralRunnerEndpointLocale = 'en' | 'fr';

const ENDPOINT_COPY_EN = Object.freeze({
  'app.name': 'Happier Runner',
  'action.stop': 'Stop Session',
  'action.retry': 'Retry',
  'action.exit': 'Exit',
  'action.allow': 'Allow',
  'action.decline': 'Decline',
  'action.keepOpen': 'Keep open',
  'consent.question': 'Allow this exact request?',
  'consent.optionalAccessQuestion': 'Also allow the plugin optional {capability} access: {reason}?',
  'review.optionalAccessChoices': 'Optional plugin access (off unless you turn it on)',
  'registry.title': 'Sign in to a private registry',
  'registry.detail': 'The reviewed Agent plugin {package} is published on the private registry {registry}. Sign in to that registry on this computer to continue. Nothing from the requester’s account is used, and the token stays on this computer.',
  'registry.signInAgain': 'This computer’s sign-in for {registry} was refused. Sign in again to continue.',
  'registry.tokenLabel': 'Registry token',
  'registry.tokenPrompt': 'Registry token (input hidden): ',
  'registry.signIn': 'Sign in',
  'registry.withoutToken': 'Continue without a token',
  'registry.question': 'Sign in, continue without a token, or decline?',
  'directory.title': 'Choose the Agent working folder',
  'directory.dialogTitle': 'Choose the Happier Runner working folder',
  'directory.choose': 'Choose folder',
  'directory.cancel': 'Cancel request',
  'directory.unavailable': 'The selected folder is no longer available. Choose another folder.',
  'close.startingTitle': 'The Agent is still starting',
  'close.runningTitle': 'The Agent is still running',
  'close.consequence': "Stopping ends the Session on this computer and revokes this Runner's access. Keeping Happier Runner open leaves the Agent working and Stop Session available.",
  'failure.beforeSession': 'The request could not be prepared. Check the activation and try again.',
  'failure.beforeSessionTerminal': 'The request could not be prepared, so nothing was started on this computer. Ask for a new package in Happier.',
  'failure.afterSession': 'The local Agent has stopped. Open the ordinary Session in Happier for details.',
  'failure.closeUnconfirmed': 'Runner stopped on this computer. Cancellation with Home could not be confirmed. Open Happier to check the request.',
  'failure.fallback': 'The Runner stopped before it could finish.',
  'failure.question': 'Retry this activation or exit?',
  'phase.connecting': 'Connecting to Home',
  'phase.selectingFolder': 'Choose a folder',
  'phase.reviewing': 'Review the exact request',
  'phase.installingAgent': 'Installing Agent',
  'phase.checkingAiAccess': 'Checking AI access',
  'phase.waitingForMaterialization': 'Waiting for organizer',
  'phase.starting': 'Starting Agent',
  'phase.running': 'Agent is running',
  'phase.stopping': 'Stopping Session',
  'phase.completed': 'Session completed',
  'phase.failed': 'Happier Runner could not continue',
  'connection.reconnecting': 'Reconnecting',
  'connection.reconnectingDetail': 'The current Session remains selected while its connection returns.',
  'connection.connectedDetail': 'Connected. Access lasts until stopped.',
  'value.none': 'None',
  'value.sealed': '{name} (value sealed)',
  'review.title': 'Review the exact request',
  'review.section.application': 'Application and publisher',
  'review.section.destination': 'Home and destination',
  'review.section.runtime': 'Agent and AI access',
  'review.section.plugin': 'Plugin installation and access',
  'review.section.request': 'Request',
  'review.section.attachments': 'Files ({count})',
  'review.details': 'Technical details',
  'review.trust.unverifiedPublisher': '{name} · Unverified publisher ({id})',
  'review.trust.notProvided': 'Not provided',
  'review.trust.verified': 'Verified',
  'review.trust.unsupported': 'Verification unsupported',
  'review.trust.declaredUnverified': 'Declared, not verified',
  'review.trust.retrievedUnverified': 'Retrieved, not verified',
  'review.trust.unavailable': 'Unavailable',
  'review.trust.notApplicable': 'Not applicable',
  'review.trust.approved': 'Approved',
  'review.trust.unreviewed': 'Unreviewed',
  'review.application': 'Application',
  'review.publisher': 'Publisher',
  'review.artifact': 'Release artifact',
  'review.home': 'Home',
  'review.homeId': 'Home ID',
  'review.requestedBy': 'Requested by',
  'review.requesterId': 'Requester ID',
  'review.team': 'Team',
  'review.teamId': 'Team ID',
  'review.folder': 'Working folder',
  'review.agent': 'Agent',
  'review.agentId': 'Agent ID',
  'review.model': 'Model',
  'review.modelId': 'Model ID',
  'review.permissions': 'Permissions',
  'review.profile': 'Profile',
  'review.environment': 'Environment variables',
  'review.mcp': 'MCP servers',
  'review.mcpMaterial': 'Resolved MCP configuration',
  'review.connectedServices': 'Connected Services',
  'review.connectedServiceBindings': 'Connected Service account bindings',
  'review.acpMode': 'ACP Session mode',
  'review.sessionConfiguration': 'Session configuration',
  'review.transcriptStorage': 'Transcript storage',
  'review.checkout': 'Checkout creation',
  'review.resumeSession': 'Resume Session',
  'review.terminal': 'Terminal',
  'review.windowsLaunchPreferences': 'Windows launch preferences',
  'review.windowsNotApplied': 'Not applied by the native Runner shell: {value}',
  'review.aiSource': 'AI source',
  'review.aiSourceId': 'AI source ID',
  'review.aiResource': 'AI resource ID',
  'review.brokerMachine': 'Broker Machine',
  'review.pluginPackage': 'Plugin to install',
  'review.pluginIntegrity': 'Plugin integrity',
  'review.pluginPublisher': 'Plugin publisher',
  'review.pluginUpdateChannel': 'Plugin update channel',
  'review.pluginCuration': 'Plugin review status',
  'review.pluginExecutableCode': 'Plugin executable code',
  'review.pluginRequiredAccess': 'Plugin required host access',
  'review.pluginOptionalAccess': 'Plugin optional host access',
  'review.pluginSignature': 'Plugin signature',
  'review.pluginProvenance': 'Plugin provenance',
  'review.pluginRequestInterceptors': 'Plugin network interception',
  'review.pluginRawCredentialAccess': 'Plugin raw credential access',
  'review.none': 'None',
  'review.prompt': 'Prompt',
  'review.references': 'References',
  'review.initialAccess': 'Initial access',
  'review.organizationPlacement': 'Organization placement',
  'review.comments': 'Review comments',
  'review.actionPolicy': 'Action policy',
  'review.attachmentDestination': 'Destination',
  'review.workspaceFolder': 'Workspace folder',
  'review.vcsIgnore': 'Version-control ignore behavior',
  'review.vcsIgnoreWrites': 'Version-control ignore writes',
  'review.enabled': 'Enabled',
  'review.disabled': 'Disabled',
  'review.unknown': 'unknown',
  'review.fileId': 'ID',
  'review.mediaType': 'Media type',
  'review.size': 'Size',
  'review.bytes': '{count} bytes',
  'review.notice1': "The Agent runs with the current OS user's permissions. The selected folder is not a sandbox,",
  'review.notice2': 'and the Agent may access other files that this OS user can access.',
  'terminal.stopPrompt': 'Type S then Enter to Stop Session (or press Enter to keep it running):',
  'terminal.stillRunning': 'Session is still running. Stop Session remains available here.',
  'terminal.stopUnavailable': 'The Stop prompt is unavailable. Press Ctrl-C to request the same Stop decision.',
  'fatal.safe': 'Happier Runner could not continue. Open Happier for details.',
} as const);

type EndpointCopyKey = keyof typeof ENDPOINT_COPY_EN;

const ENDPOINT_COPY_FR = Object.freeze({
  'app.name': 'Happier Runner',
  'action.stop': 'Arrêter la session',
  'action.retry': 'Réessayer',
  'action.exit': 'Quitter',
  'action.allow': 'Autoriser',
  'action.decline': 'Refuser',
  'action.keepOpen': 'Garder ouvert',
  'consent.question': 'Autoriser cette demande exacte ?',
  'consent.optionalAccessQuestion': 'Autoriser aussi l’accès facultatif {capability} du plugin : {reason} ?',
  'review.optionalAccessChoices': 'Accès facultatif du plugin (désactivé sauf si tu l’actives)',
  'registry.title': 'Se connecter à un registre privé',
  'registry.detail': 'Le plugin d’Agent vérifié {package} est publié sur le registre privé {registry}. Connecte-toi à ce registre sur cet ordinateur pour continuer. Rien du compte du demandeur n’est utilisé, et le jeton reste sur cet ordinateur.',
  'registry.signInAgain': 'La connexion de cet ordinateur à {registry} a été refusée. Reconnecte-toi pour continuer.',
  'registry.tokenLabel': 'Jeton du registre',
  'registry.tokenPrompt': 'Jeton du registre (saisie masquée) : ',
  'registry.signIn': 'Se connecter',
  'registry.withoutToken': 'Continuer sans jeton',
  'registry.question': 'Se connecter, continuer sans jeton ou refuser ?',
  'directory.title': 'Choisir le dossier de travail de l’Agent',
  'directory.dialogTitle': 'Choisir le dossier de travail de Happier Runner',
  'directory.choose': 'Choisir un dossier',
  'directory.cancel': 'Annuler la demande',
  'directory.unavailable': 'Le dossier sélectionné n’est plus disponible. Choisis-en un autre.',
  'close.startingTitle': 'L’Agent est encore en cours de démarrage',
  'close.runningTitle': 'L’Agent est toujours en cours d’exécution',
  'close.consequence': 'Arrêter met fin à la session sur cet ordinateur et révoque l’accès de ce Runner. Garder Happier Runner ouvert laisse l’Agent travailler et maintient l’action Arrêter la session disponible.',
  'failure.beforeSession': 'La demande n’a pas pu être préparée. Vérifie l’activation et réessaie.',
  'failure.beforeSessionTerminal': 'La demande n’a pas pu être préparée, donc rien n’a démarré sur cet ordinateur. Demande un nouveau paquet dans Happier.',
  'failure.afterSession': 'L’Agent local s’est arrêté. Ouvre la session ordinaire dans Happier pour plus de détails.',
  'failure.closeUnconfirmed': 'Le Runner s’est arrêté sur cet ordinateur. L’annulation auprès du Home n’a pas pu être confirmée. Ouvre Happier pour vérifier la demande.',
  'failure.fallback': 'Le Runner s’est arrêté avant de pouvoir terminer.',
  'failure.question': 'Réessayer cette activation ou quitter ?',
  'phase.connecting': 'Connexion au Home',
  'phase.selectingFolder': 'Choisir un dossier',
  'phase.reviewing': 'Vérifier la demande exacte',
  'phase.installingAgent': 'Installation de l’Agent',
  'phase.checkingAiAccess': 'Vérification de l’accès à l’IA',
  'phase.waitingForMaterialization': 'En attente de l’organisateur',
  'phase.starting': 'Démarrage de l’Agent',
  'phase.running': 'L’Agent est en cours d’exécution',
  'phase.stopping': 'Arrêt de la session',
  'phase.completed': 'Session terminée',
  'phase.failed': 'Happier Runner ne peut pas continuer',
  'connection.reconnecting': 'Reconnexion',
  'connection.reconnectingDetail': 'La session actuelle reste sélectionnée pendant le rétablissement de la connexion.',
  'connection.connectedDetail': 'Connecté. L’accès dure jusqu’à l’arrêt.',
  'value.none': 'Aucun',
  'value.sealed': '{name} (valeur scellée)',
  'review.title': 'Vérifier la demande exacte',
  'review.section.application': 'Application et éditeur',
  'review.section.destination': 'Home et destination',
  'review.section.runtime': 'Agent et accès à l’IA',
  'review.section.plugin': 'Installation et accès du plugin',
  'review.section.request': 'Demande',
  'review.section.attachments': 'Fichiers ({count})',
  'review.details': 'Détails techniques',
  'review.trust.unverifiedPublisher': '{name} · Éditeur non vérifié ({id})',
  'review.trust.notProvided': 'Non fourni',
  'review.trust.verified': 'Vérifié',
  'review.trust.unsupported': 'Vérification non prise en charge',
  'review.trust.declaredUnverified': 'Déclarée, non vérifiée',
  'review.trust.retrievedUnverified': 'Récupérée, non vérifiée',
  'review.trust.unavailable': 'Indisponible',
  'review.trust.notApplicable': 'Sans objet',
  'review.trust.approved': 'Approuvé',
  'review.trust.unreviewed': 'Non examiné',
  'review.application': 'Application',
  'review.publisher': 'Éditeur',
  'review.artifact': 'Artefact de version',
  'review.home': 'Home',
  'review.homeId': 'ID du Home',
  'review.requestedBy': 'Demandé par',
  'review.requesterId': 'ID du demandeur',
  'review.team': 'Équipe',
  'review.teamId': 'ID de l’équipe',
  'review.folder': 'Dossier de travail',
  'review.agent': 'Agent',
  'review.agentId': 'ID de l’Agent',
  'review.model': 'Modèle',
  'review.modelId': 'ID du modèle',
  'review.permissions': 'Autorisations',
  'review.profile': 'Profil',
  'review.environment': 'Variables d’environnement',
  'review.mcp': 'Serveurs MCP',
  'review.mcpMaterial': 'Configuration MCP résolue',
  'review.connectedServices': 'Services connectés',
  'review.connectedServiceBindings': 'Liaisons de comptes des services connectés',
  'review.acpMode': 'Mode de session ACP',
  'review.sessionConfiguration': 'Configuration de la session',
  'review.transcriptStorage': 'Stockage de la transcription',
  'review.checkout': 'Création du checkout',
  'review.resumeSession': 'Reprendre la session',
  'review.terminal': 'Terminal',
  'review.windowsLaunchPreferences': 'Préférences de lancement Windows',
  'review.windowsNotApplied': 'Non appliqué par l’interface native du Runner : {value}',
  'review.aiSource': 'Source d’IA',
  'review.aiSourceId': 'ID de la source d’IA',
  'review.aiResource': 'ID de la ressource d’IA',
  'review.brokerMachine': 'Machine de courtage',
  'review.pluginPackage': 'Plugin à installer',
  'review.pluginIntegrity': 'Intégrité du plugin',
  'review.pluginPublisher': 'Éditeur du plugin',
  'review.pluginUpdateChannel': 'Canal de mise à jour du plugin',
  'review.pluginCuration': 'Statut de revue du plugin',
  'review.pluginExecutableCode': 'Code exécutable du plugin',
  'review.pluginRequiredAccess': 'Accès hôte requis par le plugin',
  'review.pluginOptionalAccess': 'Accès hôte facultatif du plugin',
  'review.pluginSignature': 'Signature du plugin',
  'review.pluginProvenance': 'Provenance du plugin',
  'review.pluginRequestInterceptors': 'Interception réseau du plugin',
  'review.pluginRawCredentialAccess': 'Accès du plugin aux identifiants bruts',
  'review.none': 'Aucun',
  'review.prompt': 'Invite',
  'review.references': 'Références',
  'review.initialAccess': 'Accès initial',
  'review.organizationPlacement': 'Emplacement dans l’organisation',
  'review.comments': 'Commentaires de revue',
  'review.actionPolicy': 'Politique des actions',
  'review.attachmentDestination': 'Destination',
  'review.workspaceFolder': 'Dossier de l’espace de travail',
  'review.vcsIgnore': 'Comportement d’exclusion du contrôle de version',
  'review.vcsIgnoreWrites': 'Écritures d’exclusion du contrôle de version',
  'review.enabled': 'Activé',
  'review.disabled': 'Désactivé',
  'review.unknown': 'inconnu',
  'review.fileId': 'ID',
  'review.mediaType': 'Type de média',
  'review.size': 'Taille',
  'review.bytes': '{count} octets',
  'review.notice1': 'L’Agent s’exécute avec les autorisations de l’utilisateur actuel du système. Le dossier sélectionné n’est pas un bac à sable,',
  'review.notice2': 'et l’Agent peut accéder aux autres fichiers accessibles à cet utilisateur du système.',
  'terminal.stopPrompt': 'Saisis S puis Entrée pour arrêter la session (ou appuie sur Entrée pour la laisser s’exécuter) :',
  'terminal.stillRunning': 'La session est toujours en cours. Arrêter la session reste disponible ici.',
  'terminal.stopUnavailable': 'L’invite d’arrêt est indisponible. Appuie sur Ctrl-C pour demander le même arrêt.',
  'fatal.safe': 'Happier Runner ne peut pas continuer. Ouvre Happier pour plus de détails.',
} as const satisfies Record<EndpointCopyKey, string>);

const ENDPOINT_COPY = Object.freeze({ en: ENDPOINT_COPY_EN, fr: ENDPOINT_COPY_FR });

export const EPHEMERAL_RUNNER_ENDPOINT_TRANSLATION_KEYS = Object.freeze(
  Object.keys(ENDPOINT_COPY_EN) as EndpointCopyKey[],
);

export function resolveEphemeralRunnerEndpointLocale(input: Readonly<{
  locale?: string | null;
  environment?: NodeJS.ProcessEnv;
}> = {}): EphemeralRunnerEndpointLocale {
  const environment = input.environment ?? process.env;
  const normalize = (candidate: string | null | undefined): string | null => (
    candidate?.trim().split('.')[0]?.split('@')[0]?.replaceAll('_', '-').toLowerCase() || null
  );
  const select = (candidate: string | null | undefined): EphemeralRunnerEndpointLocale | null => {
    const normalized = normalize(candidate);
    if (normalized === 'fr' || normalized?.startsWith('fr-')) return 'fr';
    if (normalized === 'en' || normalized?.startsWith('en-')) return 'en';
    return null;
  };
  if (input.locale !== undefined && input.locale !== null) return select(input.locale) ?? 'en';
  const candidates = [
    environment.LC_ALL,
    environment.LC_MESSAGES,
    environment.LANGUAGE?.split(':')[0],
    environment.LANG,
    Intl.DateTimeFormat().resolvedOptions().locale,
  ];
  const effectiveLocale = candidates.find((candidate) => candidate?.trim());
  return select(effectiveLocale) ?? 'en';
}

function createEndpointTranslator(locale: EphemeralRunnerEndpointLocale) {
  const copy = ENDPOINT_COPY[locale];
  return (key: EndpointCopyKey, values: Readonly<Record<string, string | number>> = {}): string => {
    let value: string = copy[key];
    for (const [name, replacement] of Object.entries(values)) {
      value = value.replaceAll(`{${name}}`, () => String(replacement));
    }
    return value;
  };
}

export function resolveEphemeralRunnerSafeFatalError(input: Readonly<{ locale?: string | null }> = {}): string {
  const locale = resolveEphemeralRunnerEndpointLocale(input);
  return createEndpointTranslator(locale)('fatal.safe');
}

export type EphemeralRunnerEndpointPresentationAction =
  | 'stop_session'
  | 'retry'
  | 'exit';

/**
 * The endpoint's control copy, owned once. Every visible label the Runner shows
 * is resolved here and travels with the decision it belongs to, so no renderer —
 * terminal, native shell, or a later surface — writes endpoint words of its own.
 * This module therefore owns the endpoint-portable catalog. The Runner ships as
 * a signed Tauri shell plus a `happier-runner-core` sidecar built from this
 * package; Happier's app `t()` store lives in `apps/ui` and is intentionally not
 * pulled into this narrow executable. Keep every endpoint word here so a locale
 * change reaches every renderer without introducing a second copy owner.
 */
/** A valid action and the exact label the endpoint shows for it. */
export type EphemeralRunnerEndpointActionPresentation = Readonly<{
  id: EphemeralRunnerEndpointPresentationAction;
  label: string;
}>;

const ENDPOINT_ACTION_COPY_KEYS = {
  stop_session: 'action.stop',
  retry: 'action.retry',
  exit: 'action.exit',
} as const satisfies Record<EphemeralRunnerEndpointPresentationAction, EndpointCopyKey>;

function endpointAction(
  id: EphemeralRunnerEndpointPresentationAction,
  locale: EphemeralRunnerEndpointLocale,
): EphemeralRunnerEndpointActionPresentation {
  const t = createEndpointTranslator(locale);
  return Object.freeze({ id, label: t(ENDPOINT_ACTION_COPY_KEYS[id]) });
}

/**
 * The folder step's copy, including the title of the operating system's own
 * dialog. Cancelling that dialog is not an answer, so the cancel label names the
 * only input that closes the activation.
 */
export type EphemeralRunnerDirectoryChoicePresentation = Readonly<{
  documentLanguage: EphemeralRunnerEndpointLocale;
  title: string;
  dialogTitle: string;
  chooseLabel: string;
  cancelLabel: string;
}>;

export function resolveEphemeralRunnerDirectoryChoicePresentation(input: Readonly<{
  locale?: string | null;
}> = {}): EphemeralRunnerDirectoryChoicePresentation {
  const locale = resolveEphemeralRunnerEndpointLocale(input);
  const t = createEndpointTranslator(locale);
  return Object.freeze({
    documentLanguage: locale,
    title: t('directory.title'),
    // The OS dialog is chrome the endpoint sees outside the Runner window, so it
    // names the application that opened it.
    dialogTitle: t('directory.dialogTitle'),
    chooseLabel: t('directory.choose'),
    cancelLabel: t('directory.cancel'),
  });
}

/**
 * The private-registry question the endpoint answers before the installation
 * review exists. It names the exact registry and package, and says plainly that
 * the requester's credentials are not used.
 */
export type EphemeralRunnerRegistryProfilePresentation = Readonly<{
  documentLanguage: EphemeralRunnerEndpointLocale;
  title: string;
  detail: string;
  /** Present only when this computer's existing sign-in was refused. */
  signInAgain: string | null;
  tokenLabel: string;
  signInLabel: string;
  withoutTokenLabel: string;
  declineLabel: string;
}>;

export function resolveEphemeralRunnerRegistryProfilePresentation(input: Readonly<{
  requirement: PluginRegistryProfileRequirement;
  locale?: string | null;
}>): EphemeralRunnerRegistryProfilePresentation {
  const locale = resolveEphemeralRunnerEndpointLocale(input);
  const t = createEndpointTranslator(locale);
  const registry = input.requirement.registryOrigin;
  return Object.freeze({
    documentLanguage: locale,
    title: t('registry.title'),
    detail: t('registry.detail', { package: input.requirement.packageName, registry }),
    signInAgain: input.requirement.registryProfileId === null ? null : t('registry.signInAgain', { registry }),
    tokenLabel: t('registry.tokenLabel'),
    signInLabel: t('registry.signIn'),
    withoutTokenLabel: t('registry.withoutToken'),
    declineLabel: t('action.decline'),
  });
}

/** The window-close question and its exact consequence for the active phase. */
export type EphemeralRunnerActiveClosePresentation = Readonly<{
  documentLanguage: EphemeralRunnerEndpointLocale;
  title: string;
  consequence: string;
  keepOpenLabel: string;
  stopLabel: string;
}>;

export function resolveEphemeralRunnerActiveClosePresentation(input: Readonly<{
  phase: Extract<EphemeralRunnerEndpointPhase, 'starting' | 'running'>;
  locale?: string | null;
}>): EphemeralRunnerActiveClosePresentation {
  const locale = resolveEphemeralRunnerEndpointLocale(input);
  const t = createEndpointTranslator(locale);
  return Object.freeze({
    documentLanguage: locale,
    title: input.phase === 'starting'
      ? t('close.startingTitle')
      : t('close.runningTitle'),
    consequence: t('close.consequence'),
    keepOpenLabel: t('action.keepOpen'),
    stopLabel: t('action.stop'),
  });
}

/**
 * The one failure-kind-to-copy mapping. Both the recovery prompt and the
 * endpoint presentation read it, so a new kind cannot render one way here and
 * another way there.
 */
const FAILURE_COPY_KEYS = {
  before_session: 'failure.beforeSession',
  before_session_terminal: 'failure.beforeSessionTerminal',
  session_runtime_or_stop: 'failure.afterSession',
  activation_close_unconfirmed: 'failure.closeUnconfirmed',
} as const satisfies Record<EphemeralRunnerEndpointFailure['kind'], EndpointCopyKey>;

/** The terminal or retryable failure and the recovery the endpoint may choose. */
export type EphemeralRunnerFailureRecoveryPresentation = Readonly<{
  documentLanguage: EphemeralRunnerEndpointLocale;
  message: string;
  question: string;
  retryLabel: string;
  exitLabel: string;
}>;

export function resolveEphemeralRunnerFailureRecoveryPresentation(input: Readonly<{
  failure: EphemeralRunnerEndpointFailure;
  locale?: string | null;
}>): EphemeralRunnerFailureRecoveryPresentation {
  const locale = resolveEphemeralRunnerEndpointLocale(input);
  const t = createEndpointTranslator(locale);
  return Object.freeze({
    documentLanguage: locale,
    message: t(FAILURE_COPY_KEYS[input.failure.kind]),
    question: t('failure.question'),
    retryLabel: t('action.retry'),
    exitLabel: t('action.exit'),
  });
}

/**
 * Closed presentation seam for the terminal endpoint and future native shells.
 * Rendering code receives already-decided state and valid actions; it does not
 * interpret activation, transport, or process lifecycle independently.
 */
export type EphemeralRunnerEndpointPresentation = Readonly<{
  documentLanguage: EphemeralRunnerEndpointLocale;
  heading: string;
  status: string;
  detail: string | null;
  announcement: Readonly<{
    priority: 'polite' | 'assertive';
    text: string;
  }>;
  focusTarget: 'heading' | 'primary_recovery';
  actions: readonly EphemeralRunnerEndpointActionPresentation[];
  /**
   * The phase-appropriate detail panel. Consent-only material — prompt,
   * attachments, digests, action policy, the consent notice — is projected once
   * for the consent decision and never republished, so the surface a consented
   * Session leaves behind stays quiet.
   */
  facts: readonly EphemeralRunnerConsentReviewFact[];
}>;

type PresentationInput = EphemeralRunnerEndpointSnapshot & Readonly<{
  locale?: string | null;
  canRetry?: boolean;
  /** Present only after this surface rendered the review it was consented from. */
  reviewedRuntimeSummary?: readonly EphemeralRunnerConsentReviewFact[];
}>;

const PHASE_COPY_KEYS: Readonly<Record<EphemeralRunnerEndpointPhase, EndpointCopyKey>> = Object.freeze({
  connecting: 'phase.connecting',
  selecting_folder: 'phase.selectingFolder',
  reviewing: 'phase.reviewing',
  installing_agent: 'phase.installingAgent',
  checking_ai_access: 'phase.checkingAiAccess',
  waiting_for_materialization: 'phase.waitingForMaterialization',
  starting: 'phase.starting',
  running: 'phase.running',
  stopping: 'phase.stopping',
  completed: 'phase.completed',
  failed: 'phase.failed',
});

export function resolveEphemeralRunnerEndpointPresentation(
  input: PresentationInput,
): EphemeralRunnerEndpointPresentation {
  const locale = resolveEphemeralRunnerEndpointLocale(input);
  const t = createEndpointTranslator(locale);
  const failed = input.phase === 'failed';
  const reconnecting = input.connection === 'reconnecting'
    && !['completed', 'failed'].includes(input.phase);
  const status = reconnecting ? t('connection.reconnecting') : t(PHASE_COPY_KEYS[input.phase]);
  const detail = failed
    ? input.failure
      ? t(FAILURE_COPY_KEYS[input.failure.kind])
      : t('failure.fallback')
    : reconnecting
      ? t('connection.reconnectingDetail')
      : input.phase === 'running' && input.connection === 'connected'
        ? t('connection.connectedDetail')
        : null;
  const actionIds: readonly EphemeralRunnerEndpointPresentationAction[] = ['starting', 'running'].includes(input.phase)
    ? ['stop_session']
    : failed
      ? input.canRetry === true ? ['retry', 'exit'] : ['exit']
      : [];
  const facts = ['starting', 'running', 'stopping'].includes(input.phase)
    ? input.reviewedRuntimeSummary ?? []
    : [];
  return Object.freeze({
    documentLanguage: locale,
    heading: t('app.name'),
    status,
    detail,
    announcement: Object.freeze({
      priority: failed ? 'assertive' : 'polite',
      text: detail ? `${status}. ${detail}` : status,
    }),
    focusTarget: failed ? 'primary_recovery' : 'heading',
    actions: Object.freeze(actionIds.map((id) => endpointAction(id, locale))),
    facts: Object.freeze([...facts]),
  });
}

type EndpointTranslator = ReturnType<typeof createEndpointTranslator>;

function displayValue(value: unknown, t: EndpointTranslator): string {
  if (value === null || value === undefined || value === '') return t('value.none');
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function displayEnvironmentVariableNames(value: Readonly<Record<string, string>> | null, t: EndpointTranslator): string {
  const names = Object.keys(value ?? {}).sort();
  return names.length === 0 ? t('value.none') : names.map((name) => t('value.sealed', { name })).join('\n');
}

function displayMcpMaterial(
  value: RunnerLaunchManifestV1['preparedAuthoring']['mcpMaterial'],
  t: EndpointTranslator,
): string {
  // Verified runtime manifests spell this out. Keep the display boundary total
  // without ever falling back to rendering an unclassified material object.
  if (value == null) return t('value.none');
  return displayValue({
    strictMode: value.strictMode,
    capabilitySelection: value.capabilitySelection,
    servers: value.servers.map((server) => ({
      serverId: server.serverId,
      serverRevision: server.serverRevision,
      bindingId: server.bindingId,
      bindingRevision: server.bindingRevision,
      savedSecretRevisions: server.savedSecretRevisions,
      config: {
        id: server.config.id,
        name: server.config.name,
        title: server.config.title,
        description: server.config.description,
        transport: server.config.transport,
        stdio: server.config.stdio
          ? { command: server.config.stdio.command, argumentCount: server.config.stdio.args.length }
          : undefined,
        remote: server.config.remote
          ? { url: server.config.remote.url, headerNames: Object.keys(server.config.remote.headers).sort() }
          : undefined,
        environmentVariableNames: Object.keys(server.config.env).sort(),
        createdAt: server.config.createdAt,
        updatedAt: server.config.updatedAt,
      },
    })),
  }, t);
}

export type EphemeralRunnerConsentReviewFact = Readonly<{
  /** Stable identity so a renderer can order or emphasize without reparsing labels. */
  id: string;
  label: string;
  value: string;
  /** Exact evidence remains reviewable below the decision facts. */
  detail?: boolean;
}>;

export type EphemeralRunnerConsentReviewSection = Readonly<{
  id: 'application' | 'destination' | 'runtime' | 'request' | 'attachments' | 'plugin';
  title: string;
  detailsLabel: string;
  facts: readonly EphemeralRunnerConsentReviewFact[];
}>;

/**
 * The one closed consent-review view-model. Every endpoint surface — terminal
 * and native shell — renders exactly this, so a fact can never be visible on one
 * and silently missing on the other.
 *
 * It is derived only from the immutable verified launch manifest and the
 * endpoint-selected folder. Endpoint facts, the Machine content-key binding,
 * and non-presentation Provider metadata stay with the endpoint controller;
 * only the verified model name and exact source identity reach renderers.
 */
export type EphemeralRunnerConsentReviewPresentation = Readonly<{
  documentLanguage: EphemeralRunnerEndpointLocale;
  heading: string;
  title: string;
  sections: readonly EphemeralRunnerConsentReviewSection[];
  /** Truthful OS-permission statement; the working folder is not a sandbox. */
  notice: readonly string[];
  declineLabel: string;
  allowLabel: string;
  /** Allow is never automatic or pre-selected. */
  defaultDecision: 'decline';
  /**
   * The reviewed plugin's optional host access the endpoint may grant with
   * Allow. Every choice starts off; an empty list means there is none to grant.
   */
  optionalAccess: Readonly<{
    title: string;
    choices: readonly Readonly<{ accessId: string; label: string }>[];
  }>;
}>;

function fact(id: string, label: string, value: string): EphemeralRunnerConsentReviewFact {
  return Object.freeze({ id, label, value });
}

/** Humanizes only an already-verified exact identity; it never consults a local catalog. */
function humanizeIdentityLocalId(value: string): string {
  const localId = value.includes('/') ? value.slice(value.lastIndexOf('/') + 1) : value;
  const words = localId.split(/[._-]+/u).filter(Boolean);
  if (words.length === 0) return localId;
  return words.map((word) => word === word.toUpperCase()
    ? word
    : `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(' ');
}

const REVIEW_DECISION_FACT_IDS = new Set([
  'application', 'publisher', 'home', 'requested_by', 'team', 'folder',
  'agent', 'model', 'permissions', 'ai_source', 'prompt',
  'initial_access', 'action_policy', 'profile', 'environment', 'mcp', 'mcp_material',
  'connected_services', 'connected_service_bindings',
  'plugin_package', 'plugin_publisher', 'plugin_curation', 'plugin_signature', 'plugin_provenance',
  'plugin_executable_code', 'plugin_required_access', 'plugin_optional_access',
  'plugin_request_interceptors', 'plugin_raw_credential_access',
  'attachment_destination', 'workspace_folder',
]);

function section(
  id: EphemeralRunnerConsentReviewSection['id'],
  title: string,
  facts: readonly EphemeralRunnerConsentReviewFact[],
  t: EndpointTranslator,
): EphemeralRunnerConsentReviewSection {
  return Object.freeze({
    id,
    title,
    detailsLabel: t('review.details'),
    facts: Object.freeze(facts.map((entry) => Object.freeze({
      ...entry,
      detail: !REVIEW_DECISION_FACT_IDS.has(entry.id) && !entry.id.startsWith('file:'),
    }))),
  });
}

/**
 * The plugin-acquisition facts a present endpoint user decides on, taken
 * verbatim from the canonical `PluginInstallationReview` the plugin change
 * owner produced. Absent when nothing is being installed, so a bundled Agent
 * never shows an empty install block.
 */
/**
 * Host-access disclosure, including the normalized scope the canonical review
 * carries. A capability name without its scope is not the same disclosure the
 * settings surface makes, and this endpoint user carries the consequence.
 */
type HostAccessRequest = Readonly<{
  id: string;
  capability: string;
  reason: string;
  normalizedScope: Readonly<Record<string, unknown>>;
}>;

function hostAccessLine(entry: HostAccessRequest): string {
  const scope = Object.keys(entry.normalizedScope).length > 0
    ? ` ${JSON.stringify(entry.normalizedScope)}`
    : '';
  return `${entry.capability} (${entry.id}): ${entry.reason}${scope}`;
}

function hostAccessLines(
  access: readonly HostAccessRequest[],
  t: EndpointTranslator,
): string {
  if (access.length === 0) return t('review.none');
  return access.map(hostAccessLine).join('\n');
}

function pluginInstallationFacts(
  review: PluginInstallationReview | null,
  t: EndpointTranslator,
): readonly EphemeralRunnerConsentReviewFact[] {
  if (!review) return [];
  const publisher = review.publisherIdentity.status === 'unverified'
    ? t('review.trust.unverifiedPublisher', { name: review.publisherIdentity.displayName, id: review.publisherIdentity.id })
    : t('review.unknown');
  const updateChannel = review.updateChannel.kind === 'npm'
    ? `${review.updateChannel.packageName} · ${review.updateChannel.registryOrigin}`
    : `${review.updateChannel.kind} · ${review.updateChannel.locator}`;
  const curation = review.curation.status === 'notApplicable'
    ? t('review.trust.notApplicable')
    : `${t(`review.trust.${review.curation.status}`)} · ${review.curation.sourceId}`;
  return Object.freeze([
    fact('plugin_package', t('review.pluginPackage'), [
      `${review.displayName} ${review.version}`,
      `${review.pluginId}`,
      `${review.packageIdentity.name ?? review.pluginId}@${review.packageIdentity.version}`,
    ].join('\n')),
    fact('plugin_integrity', t('review.pluginIntegrity'), review.source.kind === 'path'
      ? review.source.locator
      : `${review.source.integrity} (${review.source.integrityBasis})`),
    fact('plugin_publisher', t('review.pluginPublisher'), publisher),
    fact('plugin_update_channel', t('review.pluginUpdateChannel'), updateChannel),
    fact('plugin_curation', t('review.pluginCuration'), curation),
    fact('plugin_signature', t('review.pluginSignature'), review.signature.status === 'notProvided'
      ? t('review.trust.notProvided')
      : `${t(`review.trust.${review.signature.status}`)} · ${review.signature.keyId}`),
    fact('plugin_provenance', t('review.pluginProvenance'), review.provenance.status === 'declaredUnverified'
      ? `${t('review.trust.declaredUnverified')} · ${review.provenance.predicateType}`
      : review.provenance.status === 'retrievedUnverified'
        ? `${t('review.trust.retrievedUnverified')} · ${review.provenance.predicateTypes.join(', ')}`
        : review.provenance.status === 'unavailable'
          ? `${t('review.trust.unavailable')} · ${review.provenance.code}`
          : t('review.trust.notProvided')),
    fact('plugin_executable_code', t('review.pluginExecutableCode'),
      review.executableRealms.length > 0 ? review.executableRealms.join(', ') : t('review.unknown')),
    fact('plugin_required_access', t('review.pluginRequiredAccess'),
      hostAccessLines(review.requiredHostAccess, t)),
    // Optional access is disclosed in full; the endpoint grants only what it
    // explicitly turns on among the choices offered with Allow.
    fact('plugin_optional_access', t('review.pluginOptionalAccess'),
      hostAccessLines(review.optionalHostAccess, t)),
    fact('plugin_request_interceptors', t('review.pluginRequestInterceptors'),
      review.requestInterceptors.length > 0
        ? review.requestInterceptors
          .map((interceptor) => [
            `${interceptor.id}: ${interceptor.origins.join(', ')}`,
            interceptor.methods && interceptor.methods.length > 0 ? ` [${interceptor.methods.join(', ')}]` : '',
          ].join(''))
          .join('\n')
        : t('review.none')),
    fact('plugin_raw_credential_access', t('review.pluginRawCredentialAccess'),
      review.rawCredentialAccess.length > 0
        ? review.rawCredentialAccess
          .map((access) => [
            `${access.contribution.localId} (${access.realm}/${access.phase})`,
            `${access.credentialSlot.title} · ${access.credentialSlot.purpose}`,
          ].join(': '))
          .join('\n')
        : t('review.none')),
  ]);
}

export function resolveEphemeralRunnerConsentReviewPresentation(input: Readonly<{
  manifest: RunnerLaunchManifestV1;
  directory: string;
  /** Canonical installation review for the plugin this endpoint must acquire. */
  pluginInstallation?: PluginInstallationReview | null;
  locale?: string | null;
}>): EphemeralRunnerConsentReviewPresentation {
  const locale = resolveEphemeralRunnerEndpointLocale(input);
  const t = createEndpointTranslator(locale);
  const { manifest, directory } = input;
  const prepared = manifest.preparedAuthoring;
  const authoring = prepared.authoring;
  const destination = prepared.attachmentDestination;
  const selection = manifest.credentialSelectionBinding;
  const reviewedModel = manifest.reviewedProviderModel;
  const artifact = manifest.binding.artifact;
  const agentTargetKey = reviewedModel.selection.agentTargetKey;
  const sourceIdentity = reviewedModel.application.implementationIdentity;

  return Object.freeze({
    documentLanguage: locale,
    heading: t('app.name'),
    title: t('review.title'),
    sections: Object.freeze([
      section('destination', t('review.section.destination'), [
        fact('home', t('review.home'), manifest.displayFacts.homeName),
        fact('home_id', t('review.homeId'), manifest.displayFacts.homeId),
        fact('requested_by', t('review.requestedBy'), manifest.displayFacts.requesterName),
        fact('requester_id', t('review.requesterId'), manifest.displayFacts.requesterId),
        fact('team', t('review.team'), manifest.displayFacts.teamName),
        fact('team_id', t('review.teamId'), manifest.displayFacts.teamId),
        fact('folder', t('review.folder'), directory),
      ], t),
      section('runtime', t('review.section.runtime'), [
        fact('agent', t('review.agent'), humanizeIdentityLocalId(agentTargetKey)),
        fact('agent_id', t('review.agentId'), agentTargetKey),
        fact('model', t('review.model'), reviewedModel.descriptor.name),
        fact('model_id', t('review.modelId'), reviewedModel.selection.modelId),
        fact('permissions', t('review.permissions'), displayValue(authoring.permissionMode, t)),
        fact('profile', t('review.profile'), displayValue(authoring.profileId, t)),
        fact('environment', t('review.environment'), displayEnvironmentVariableNames(authoring.environmentVariables, t)),
        fact('mcp', t('review.mcp'), displayValue(authoring.capabilitySelection?.mcp, t)),
        fact('mcp_material', t('review.mcpMaterial'), displayMcpMaterial(prepared.mcpMaterial, t)),
        fact('connected_services', t('review.connectedServices'), displayValue(authoring.connectedServices, t)),
        fact('connected_service_bindings', t('review.connectedServiceBindings'), displayValue(manifest.connectedServiceReviewBindings, t)),
        fact('acp_mode', t('review.acpMode'), displayValue(authoring.acpSessionModeId, t)),
        fact('session_configuration', t('review.sessionConfiguration'), displayValue(authoring.sessionConfigOptionOverrides, t)),
        fact('transcript_storage', t('review.transcriptStorage'), displayValue(authoring.transcriptStorage, t)),
        fact('checkout', t('review.checkout'), displayValue(authoring.checkoutCreationDraft, t)),
        fact('resume_session', t('review.resumeSession'), displayValue(authoring.resumeSessionId, t)),
        fact('terminal', t('review.terminal'), displayValue(authoring.terminal, t)),
        ...(
          authoring.windowsRemoteSessionLaunchMode
          || authoring.windowsRemoteSessionConsole
          || authoring.windowsTerminalWindowName
            ? [fact(
                'windows_launch_preferences',
                t('review.windowsLaunchPreferences'),
                t('review.windowsNotApplied', { value: displayValue({
                  launchMode: authoring.windowsRemoteSessionLaunchMode,
                  console: authoring.windowsRemoteSessionConsole,
                  windowName: authoring.windowsTerminalWindowName,
                }, t) }),
              )]
            : []
        ),
        fact('ai_source', t('review.aiSource'), humanizeIdentityLocalId(sourceIdentity.localId)),
        fact('ai_source_id', t('review.aiSourceId'), `${sourceIdentity.pluginId}/${sourceIdentity.localId}`),
        fact('ai_resource', t('review.aiResource'), selection.resourceId),
        fact('broker_machine', t('review.brokerMachine'), selection.brokerMachineId),
      ], t),
      section('request', t('review.section.request'), [
        fact('prompt', t('review.prompt'), displayValue(prepared.composer.text, t)),
        fact('references', t('review.references'), displayValue(prepared.composer.references, t)),
        fact('initial_access', t('review.initialAccess'), displayValue(authoring.access, t)),
        fact('organization_placement', t('review.organizationPlacement'), displayValue(authoring.organizationPlacement, t)),
        fact('review_comments', t('review.comments'), displayValue(prepared.reviewComments, t)),
        fact('action_policy', t('review.actionPolicy'), displayValue(prepared.actionsSettings, t)),
      ], t),
      ...(input.pluginInstallation ? [section('plugin', t('review.section.plugin'),
        pluginInstallationFacts(input.pluginInstallation, t), t)] : []),
      section('attachments', t('review.section.attachments', { count: prepared.files.length }), [
        ...prepared.files.map((file) => fact(`file:${file.id}`, file.name, [
          `${t('review.fileId')}: ${file.id}`,
          `${t('review.mediaType')}: ${file.mimeType ?? t('review.unknown')}`,
          `${t('review.size')}: ${t('review.bytes', { count: file.sizeBytes })}`,
          `SHA-256: ${file.sha256}`,
        ].join('\n'))),
        fact('attachment_destination', t('review.attachmentDestination'), destination.uploadLocation),
        fact('workspace_folder', t('review.workspaceFolder'), destination.workspaceRelativeDir),
        fact('vcs_ignore', t('review.vcsIgnore'), destination.vcsIgnoreStrategy),
        fact('vcs_ignore_writes', t('review.vcsIgnoreWrites'), destination.vcsIgnoreWritesEnabled ? t('review.enabled') : t('review.disabled')),
      ], t),
      section('application', t('review.section.application'), [
        fact('application', t('review.application'), `Happier Runner ${artifact.version}`),
        fact('publisher', t('review.publisher'), 'Happier'),
        fact('artifact', t('review.artifact'), `${artifact.target} · SHA-256 ${artifact.sha256}`),
      ], t),
    ]),
    notice: Object.freeze([t('review.notice1'), t('review.notice2')]),
    declineLabel: t('action.decline'),
    allowLabel: t('action.allow'),
    defaultDecision: 'decline',
    optionalAccess: Object.freeze({
      title: t('review.optionalAccessChoices'),
      choices: Object.freeze((input.pluginInstallation?.optionalHostAccess ?? []).map((entry) => Object.freeze({
        accessId: entry.id,
        label: hostAccessLine(entry),
      }))),
    }),
  });
}

function renderFact(entry: EphemeralRunnerConsentReviewFact): string {
  return entry.value.includes('\n')
    ? `${entry.label}:\n${entry.value}`
    : `${entry.label}: ${entry.value}`;
}

/** Running-phase summary; the same projection, narrowed to the persistent facts. */
const RUNTIME_SUMMARY_FACT_IDS: readonly string[] = Object.freeze([
  'home',
  'requested_by',
  'team',
  'agent',
  'folder',
]);

/**
 * The quiet running-surface facts, taken from the one consent-review projection
 * so a running surface can never show a fact the user did not consent to, and
 * never retains the consent-only material it was narrowed from.
 */
export function resolveEphemeralRunnerReviewedRuntimeFacts(input: Readonly<{
  manifest: RunnerLaunchManifestV1;
  directory: string;
  locale?: string | null;
}>): readonly EphemeralRunnerConsentReviewFact[] {
  const facts = resolveEphemeralRunnerConsentReviewPresentation(input)
    .sections.flatMap((entry) => entry.facts);
  return Object.freeze(RUNTIME_SUMMARY_FACT_IDS.flatMap((id) => {
    const entry = facts.find((candidate) => candidate.id === id);
    return entry ? [entry] : [];
  }));
}

export function formatEphemeralRunnerConsentReview(input: Readonly<{
  manifest: RunnerLaunchManifestV1;
  directory: string;
  pluginInstallation?: PluginInstallationReview | null;
  locale?: string | null;
}>): string {
  const presentation = resolveEphemeralRunnerConsentReviewPresentation(input);
  return [
    '',
    presentation.heading,
    presentation.title,
    '',
    ...presentation.sections.flatMap((entry) => [
      entry.title,
      ...entry.facts.map(renderFact),
      '',
    ]),
    ...presentation.notice,
    '',
  ].join('\n');
}

type ReadInput = typeof promptInput;

export function createEphemeralRunnerTerminalUi(input: Readonly<{
  activation: Readonly<{
    homeServerIdentityId: string;
    creatorAccountId: string;
    artifact: RunnerArtifactIdentityV1;
  }>;
  interactive?: boolean;
  write?: (value: string) => void;
  readInput?: ReadInput;
  resolveDirectory?: (value: string) => string | null;
  isDirectory?: (value: string) => Promise<boolean>;
  selectNativeDirectory?: (signal: AbortSignal) => Promise<NativeDirectoryPickerResult>;
  /** Hidden-input prompt for a registry token; the value is never echoed or written. */
  readSecret?: (prompt: string) => Promise<string>;
  locale?: string | null;
}>): EphemeralRunnerEndpointUi<RunnerLaunchManifestV1> {
  const locale = resolveEphemeralRunnerEndpointLocale({ locale: input.locale });
  const t = createEndpointTranslator(locale);
  const write = input.write ?? ((value: string) => process.stdout.write(value));
  const readInput = input.readInput ?? promptInput;
  const readSecret = input.readSecret ?? promptSecretInput;
  const interactive = input.interactive ?? isInteractiveTerminal();
  const resolveDirectory = input.resolveDirectory ?? resolveAbsolutePathFromWorkingDirectory;
  const isDirectory = input.isDirectory ?? (async (value: string) => {
    try {
      return (await stat(value)).isDirectory();
    } catch {
      return false;
    }
  });
  const directoryChoice = resolveEphemeralRunnerDirectoryChoicePresentation({ locale });
  const selectNativeDirectory = input.selectNativeDirectory
    ?? (async (signal: AbortSignal) => await selectDirectoryWithNativeDialog({
      signal,
      dialogTitle: directoryChoice.dialogTitle,
    }));
  let controls: Parameters<EphemeralRunnerEndpointUi<RunnerLaunchManifestV1>['bindControls']>[0] | null = null;
  let activeSnapshot: EphemeralRunnerEndpointSnapshot | null = null;
  let lastPresentationIdentity: string | null = null;
  let reviewedRuntimeSummary: readonly EphemeralRunnerConsentReviewFact[] = [];
  let stopPromptAbort: AbortController | null = null;
  let stopPromptTask: Promise<void> | null = null;

  const readChoice = async <TId extends string>(params: Readonly<{
    message: string;
    defaultId: TId;
    options: ReadonlyArray<Readonly<{ id: TId; keys: readonly string[]; short: string }>>;
    signal: AbortSignal;
  }>): Promise<TId> => await promptMultipleChoice(params.message, params.options, {
    defaultId: params.defaultId,
    promptInputFn: (message, options) => readInput(message, { ...options, signal: params.signal }),
  });

  const stopStopPrompt = () => {
    stopPromptAbort?.abort();
    stopPromptAbort = null;
  };

  const startStopPrompt = () => {
    if (!interactive || !controls || stopPromptTask || !activeSnapshot || !['starting', 'running'].includes(activeSnapshot.phase)) return;
    const abort = new AbortController();
    stopPromptAbort = abort;
    stopPromptTask = (async () => {
      try {
        while (!abort.signal.aborted && activeSnapshot && ['starting', 'running'].includes(activeSnapshot.phase)) {
          const answer = (await readInput(`${t('terminal.stopPrompt')} `, {
            signal: abort.signal,
          })).trim().toLowerCase();
          if (answer === 's' || answer === 'stop') {
            await controls?.requestStop();
            return;
          }
          write(`${t('terminal.stillRunning')}\n`);
        }
      } catch (error) {
        if (!abort.signal.aborted && (!(error instanceof Error) || error.name !== 'AbortError')) {
          write(`${t('terminal.stopUnavailable')}\n`);
        }
      } finally {
        if (stopPromptAbort === abort) stopPromptAbort = null;
        stopPromptTask = null;
      }
    })();
  };

  return Object.freeze({
    selectDirectory: async ({ signal }) => {
      if (!interactive) throw new Error('runner_interactive_terminal_required');
      for (;;) {
        const selection = await readChoice({
          message: directoryChoice.title,
          defaultId: 'choose',
          options: [
            { id: 'choose', keys: ['c', 'choose'], short: 'c' },
            { id: 'cancel', keys: ['x', 'cancel'], short: 'x' },
          ],
          signal,
        });
        if (selection === 'cancel') return null;
        const nativeSelection = await selectNativeDirectory(signal);
        if (nativeSelection.status === 'cancelled') continue;
        if (nativeSelection.status === 'selected') {
          const directory = resolveDirectory(nativeSelection.directory);
          if (directory && await isDirectory(directory)) return directory;
          write(`${t('directory.unavailable')}\n`);
          continue;
        }
        throw new EphemeralRunnerNativeDirectoryPickerUnavailableError();
      }
    },
    requestRegistryProfile: async ({ requirement, signal }) => {
      if (!interactive) throw new Error('runner_interactive_terminal_required');
      const registry = resolveEphemeralRunnerRegistryProfilePresentation({ requirement, locale });
      write(`\n${registry.title}\n${registry.detail}\n${registry.signInAgain ? `${registry.signInAgain}\n` : ''}`);
      for (;;) {
        const answer = await readChoice({
          message: t('registry.question'),
          defaultId: 'decline',
          options: [
            { id: 'sign_in', keys: ['s', 'sign in', 'signin'], short: 's' },
            { id: 'without_token', keys: ['w', 'without', 'without token'], short: 'w' },
            { id: 'decline', keys: ['d', 'decline', 'no', 'n'], short: 'd' },
          ],
          signal,
        });
        if (answer === 'decline') return null;
        if (answer === 'without_token') return { credential: null };
        signal.throwIfAborted();
        const token = (await readSecret(t('registry.tokenPrompt'))).trim();
        signal.throwIfAborted();
        // An empty token is not an answer; ask the same question again.
        if (token) return { credential: token };
      }
    },
    reviewAndRequestConsent: async ({ review, pluginInstallation, signal }) => {
      if (!interactive) throw new Error('runner_interactive_terminal_required');
      reviewedRuntimeSummary = resolveEphemeralRunnerReviewedRuntimeFacts({
        manifest: review.manifest,
        directory: review.directory,
        locale,
      });
      write(formatEphemeralRunnerConsentReview({ ...review, pluginInstallation, locale }));
      const result = await readChoice({
        message: t('consent.question'),
        defaultId: 'decline',
        options: [
          { id: 'allow', keys: ['a', 'allow', 'yes', 'y'], short: 'a' },
          { id: 'decline', keys: ['d', 'decline', 'no', 'n'], short: 'd' },
        ],
        signal,
      });
      if (result !== 'allow') return { allow: false };
      // Each optional access request is its own explicit answer, off by default,
      // exactly as the canonical terminal plugin installation asks it.
      const optionalSelections: { accessId: string; selected: boolean }[] = [];
      for (const request of pluginInstallation?.optionalHostAccess ?? []) {
        const answer = await readChoice({
          message: t('consent.optionalAccessQuestion', { capability: request.capability, reason: request.reason }),
          defaultId: 'decline',
          options: [
            { id: 'allow', keys: ['a', 'allow', 'yes', 'y'], short: 'a' },
            { id: 'decline', keys: ['d', 'decline', 'no', 'n'], short: 'd' },
          ],
          signal,
        });
        optionalSelections.push({ accessId: request.id, selected: answer === 'allow' });
      }
      return { allow: true, optionalSelections };
    },
    confirmActiveClose: async ({ phase, signal }) => {
      stopStopPrompt();
      if (!interactive) return 'stop';
      const close = resolveEphemeralRunnerActiveClosePresentation({ phase, locale });
      let result: 'stop' | 'keep_open';
      try {
        result = await readChoice({
          message: `${close.title}. ${close.consequence}`,
          defaultId: 'keep_open',
          options: [
            { id: 'stop', keys: ['s', 'stop'], short: 's' },
            { id: 'keep_open', keys: ['k', 'keep', 'keep open'], short: 'k' },
          ],
          signal,
        });
      } catch {
        // A terminal-window close removes the only surface that could keep the
        // Agent visibly supervised. Stop locally rather than leaving hidden work.
        return 'stop';
      }
      // A Stop-triggered confirmation is still inside the old prompt task.
      // Resume only after it releases the input owner; a window-close decision
      // with no active prompt can start it immediately on the next microtask.
      if (result === 'keep_open') void (stopPromptTask ?? Promise.resolve()).then(startStopPrompt);
      return result;
    },
    requestFailureRecovery: async ({ failure, canRetry, signal }) => {
      stopStopPrompt();
      const recovery = resolveEphemeralRunnerFailureRecoveryPresentation({ failure, locale });
      if (!canRetry) {
        write(`${recovery.message}\n`);
        return 'exit';
      }
      // The retryable message already reached the surface as the failed-phase
      // detail; only the question is new here.
      if (!interactive) return 'exit';
      return await readChoice({
        message: recovery.question,
        defaultId: 'exit',
        options: [
          { id: 'retry', keys: ['r', 'retry'], short: 'r' },
          { id: 'exit', keys: ['e', 'exit'], short: 'e' },
        ],
        signal,
      });
    },
    bindControls: (nextControls) => {
      controls = nextControls;
      startStopPrompt();
      return () => {
        if (controls === nextControls) controls = null;
        stopStopPrompt();
      };
    },
    present: (snapshot) => {
      activeSnapshot = snapshot;
      if (!['starting', 'running'].includes(snapshot.phase)) stopStopPrompt();
      const presentation = resolveEphemeralRunnerEndpointPresentation({
        ...snapshot,
        reviewedRuntimeSummary,
        locale,
      });
      const identity = `${snapshot.phase}:${snapshot.connection}:${presentation.detail ?? ''}`;
      if (lastPresentationIdentity !== identity) {
        lastPresentationIdentity = identity;
        write(`\n${presentation.heading}\n${presentation.status}\n`);
        if (presentation.detail) write(`${presentation.detail}\n`);
        if (snapshot.phase === 'connecting') {
          write([
            `${t('review.application')}: Happier Runner ${input.activation.artifact.version}`,
            `${t('review.publisher')}: Happier`,
            `${t('review.artifact')}: ${input.activation.artifact.target} · SHA-256 ${input.activation.artifact.sha256}`,
            `${t('review.home')}: ${input.activation.homeServerIdentityId}`,
            `${t('review.requestedBy')}: ${input.activation.creatorAccountId}`,
            '',
          ].join('\n'));
        }
        if (presentation.facts.length > 0) {
          write(`${presentation.facts.map(renderFact).join('\n')}\n`);
        }
        const stop = presentation.actions.find((action) => action.id === 'stop_session');
        if (stop) write(`[ ${stop.label} ]\n`);
      }
      if (snapshot.phase === 'running') startStopPrompt();
    },
  });
}
