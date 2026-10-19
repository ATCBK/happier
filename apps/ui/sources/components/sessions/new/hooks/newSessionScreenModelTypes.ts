import type { View } from 'react-native';
import type { NewSessionTemporaryComputerLaunch } from '../components/NewSessionLaunchSurface';

import type { NewSessionSimplePanelProps } from '@/components/sessions/new/components/NewSessionSimplePanel';
import type {
    NewSessionWizardAgentProps,
    NewSessionWizardFooterProps,
    NewSessionWizardLayoutProps,
    NewSessionWizardMachineProps,
    NewSessionWizardProfilesProps,
    NewSessionWizardProps,
} from '@/components/sessions/new/components/NewSessionWizard';
import type { NewSessionCheckoutCreationDraft } from '@/sync/domains/state/newSessionCheckoutDraft';
import type { ManagedMachineSelectionDraft, ManagedMachineAcquisitionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import type { ManagedMachineCreationProgress } from '@/components/settings/machines/managed/managedMachineCreation';
import type { ComposerTextStore } from '@/components/sessions/agentInput/composerTextStore';
import type { SessionInstructionsAuthoringResult } from '@/sync/ops/promptLibrary/sessionInstructions';
import type { SessionInstructionsAuthoringDraft } from '@/sync/domains/state/sessionInstructionsDraft';
import type { PromptDocArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';
import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import type { ManagedMachineArchiveChoiceAvailability } from '@/components/sessions/new/components/machineSelection/managedMachineSelection';

export type NewSessionInstructionsCreationModel = Readonly<{
    titleStore: ComposerTextStore;
    markdownStore: ComposerTextStore;
    getDraft: () => SessionInstructionsAuthoringDraft | null;
    /** The draft's reserved `session.instructions` stack entry, when it attaches a Prompt Library document. */
    getEntry: () => PromptStackEntryV1 | null;
    /** Reads presentation from the shared mounted Action approval continuation. */
    getApprovalPending: () => boolean;
    /** Notifies after the draft's Instructions (authored body or attached entry) change. */
    subscribe: (listener: () => void) => () => void;
    onDraftChange: (draft: SessionInstructionsAuthoringDraft) => void;
    selectReference: (ref: PromptDocArtifactRefV1 | null) => void;
    saveDraft: () => Promise<SessionInstructionsAuthoringResult | null>;
}>;

/** The PageHeader title leaf subscribes here; typing does not render the creation screen model. */
export type NewSessionBotCreationModel = Readonly<{
    nameStore: ComposerTextStore;
    onSessionNameChange: (value: string) => void;
    /** The draft's Instructions line, shown under the Bot's name (lab `b-new`). */
    instructions?: React.ReactNode;
}>;

/** Non-visual managed configurator transaction; CUI owns its accessory/picker presentation. */
export type NewSessionManagedMachineDraftModel = Readonly<{
    selection: ManagedMachineSelectionDraft | null;
    acquisition: ManagedMachineAcquisitionDraft | null;
    select: (draft: ManagedMachineSelectionDraft, serverId?: string) => void;
    progress: ManagedMachineCreationProgress;
    retryInstallation: () => void;
    retrySetup?: () => void;
    continueWithoutSetup?: () => void;
    deleteMachine?: () => void;
    cancel?: () => void;
    updateArchiveEffect?: (effect: ManagedMachineSelectionDraft['archiveEffect']) => void;
    archiveChoiceAvailability?: ManagedMachineArchiveChoiceAvailability | null;
}>;

export type NewSessionSimpleScreenProps = NewSessionSimplePanelProps & Readonly<{
    checkoutCreationDraft: NewSessionCheckoutCreationDraft | null;
    setCheckoutCreationDraft: React.Dispatch<React.SetStateAction<NewSessionCheckoutCreationDraft | null>>;
}>;

export type NewSessionScreenModel =
    | Readonly<{
        variant: 'simple';
        popoverBoundaryRef: React.RefObject<View>;
        launchOverlay: React.ReactNode | null;
        temporaryComputerLaunch?: NewSessionTemporaryComputerLaunch;
        managedMachineDraft?: NewSessionManagedMachineDraftModel;
        botCreation?: NewSessionBotCreationModel;
        instructionsCreation?: NewSessionInstructionsCreationModel;
        launchOnRequestClose: () => void;
        overlayPresentation?: 'card' | 'screen';
        overlayFocusReturnRef?: React.RefObject<View | null>;
        overlayAccessibilityLabel?: string;
        simpleProps: NewSessionSimpleScreenProps;
    }>
    | Readonly<{
        variant: 'wizard';
        popoverBoundaryRef: React.RefObject<View>;
        launchOverlay: React.ReactNode | null;
        temporaryComputerLaunch?: NewSessionTemporaryComputerLaunch;
        managedMachineDraft?: NewSessionManagedMachineDraftModel;
        botCreation?: NewSessionBotCreationModel;
        instructionsCreation?: NewSessionInstructionsCreationModel;
        launchOnRequestClose: () => void;
        overlayPresentation?: 'card' | 'screen';
        overlayFocusReturnRef?: React.RefObject<View | null>;
        overlayAccessibilityLabel?: string;
        wizardProps: Readonly<{
            layout: NewSessionWizardLayoutProps;
            sectionPresentation?: NewSessionWizardProps['sectionPresentation'];
            useColumnLayout?: NewSessionWizardProps['useColumnLayout'];
            profiles: NewSessionWizardProfilesProps;
            agent: NewSessionWizardAgentProps;
            machine: NewSessionWizardMachineProps;
            footer: NewSessionWizardFooterProps;
        }>;
    }>;
