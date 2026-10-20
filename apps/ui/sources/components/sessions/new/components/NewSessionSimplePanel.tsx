import * as React from 'react';
import type { NewSessionLaunchApprovalNoticeState } from '@/components/sessions/new/components/NewSessionLaunchApprovalNotice';
import type { ViewStyle } from 'react-native';
import { Keyboard, Platform, Pressable, StyleSheet as RNStyleSheet, View, useWindowDimensions } from 'react-native';
import { useNavigation, useRouter } from 'expo-router';
import Animated, {
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { OverlayScrim } from '@/components/ui/overlays/OverlayScrim';
import { createModalScrimWebStyle } from '@/components/ui/overlays/createBackdropLayerStyle';
import { useGlassBlurSetting } from '@/components/ui/glass/useGlassBlurSetting';
import { ESCAPE_LAYER_PRIORITIES, EscapeLayerProvider, useEscapeLayer } from '@/keyboard/escape';
import { useUnistyles } from 'react-native-unistyles';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useNewSessionFloatingComposer } from '@/components/sessions/new/navigation/useNewSessionFloatingComposer';
import {
    NEW_SESSION_CLOSE_BUTTON_GAP,
    NEW_SESSION_CLOSE_ROW_HEIGHT,
    NewSessionComposerCloseButton,
    NewSessionComposerKeyboardDismissButton,
} from '@/components/sessions/new/components/NewSessionComposerCloseButton';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { AgentInput } from '@/components/sessions/agentInput';
import type { AgentInputExtraActionPresentation } from '@/components/sessions/agentInput/agentInputContracts';
import { PopoverBoundaryProvider } from '@/components/ui/popover';
import type { AcpConfigOptionOverridesV1, ProviderErrorV1 } from '@happier-dev/protocol';
import type { HandleCreateSessionOptions } from '../hooks/useCreateNewSession';
import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';
import { layout } from '@/components/ui/layout/layout';
import {
    ComposerKeyboardScaffold,
    useComposerKeyboardLayoutContext,
} from '@/components/sessions/keyboardAvoidance';
import {
    NewSessionLaunchPendingPreview,
} from '@/components/sessions/new/components/NewSessionLaunchPendingPreview';
import type { NewSessionLaunchAttempt } from '@/components/sessions/new/modules/newSessionLaunchAttempt';
import type { NewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import { NewSessionComposerCard } from '@/components/sessions/new/components/NewSessionComposerCard';
import type { NewSessionComposerDocument } from '@/components/sessions/new/hooks/screenModel/useNewSessionComposerDocument';
import type { SessionModelPicker } from '@/components/sessions/modelPicker/SessionModelPicker';

const SIMPLE_NEW_SESSION_MIN_TOP_GAP = 8;

/**
 * How far the composer card travels on entry.
 *
 * Durations and the curve come from `motionTokens.overlay.modal` — this is an ordinary overlay and
 * should settle like every other one. Only the distance is local, because distance is a property of
 * the surface rather than of the preset (the shared tokens range from 8 for a popover upward). A
 * bottom-anchored card wants enough travel to read as lifting into place and little enough that it
 * does not read as a sheet arriving: the preset's own 10 is invisible here, and anything past ~32
 * reads as the sheet this replaces. The tab bar the composer replaces occupies roughly this much of
 * the same space, so the card reads as rising into the layer the bar just vacated.
 */
/**
 * How far the composer's frosted band reaches above the card.
 *
 * Taller than the shared `OVERLAY_SCRIM_RAMP_HEIGHT` default: this composer floats over the session
 * list rather than over a single quiet surface, so it needs a longer run to settle against busy,
 * scrolling content. Still far short of veiling the list - keeping it readable while you type is the
 * reason this is a floating composer and not a sheet.
 */
const SIMPLE_NEW_SESSION_SCRIM_RAMP_HEIGHT = 128;

const SIMPLE_NEW_SESSION_ENTER_TRAVEL_PX = 32;

/** Shared modal arrival scale; the card grows into place rather than only sliding. */
const SIMPLE_NEW_SESSION_ENTER_FROM_SCALE = motionTokens.overlay.modal.fromScale;

/** A shorter drop on the way out — exits are quieter than entrances. */
const SIMPLE_NEW_SESSION_EXIT_TRAVEL_PX = 12;

/** How long the disarmed state may persist before it is assumed the pop never happened. */
const SIMPLE_NEW_SESSION_DISMISS_SAFETY_MS = 1000;

/** Separates the close capsule from the composer card without letting their hit areas meet. */

export type NewSessionSimplePanelProps = Readonly<{
    popoverBoundaryRef: React.RefObject<View>;
    headerHeight: number;
    safeAreaTop: number;
    safeAreaBottom: number;
    newSessionTopPadding: number;
    newSessionSidePadding: number;
    newSessionBottomPadding: number;
    shouldBottomAnchor?: boolean;
    containerStyle: ViewStyle;
    promptStore: NewSessionPromptStore;
    composerDocument?: NewSessionComposerDocument;
    composerReferenceHost?: React.ComponentProps<typeof AgentInput>['composerReferenceHost'];
    composerFileScope?: React.ComponentProps<typeof AgentInput>['composerFileScope'];
    setSessionPrompt: (v: string) => void;
    handleCreateSession: (opts?: HandleCreateSessionOptions) => void;
    /**
     * Registers this panel's Send as the one submission owner a Temporary
     * computer replacement uses. Returns its own unregistration.
     */
    registerTemporaryComputerReplacementLaunch?: (send: () => void) => () => void;
    canCreate: boolean;
    isCreating: boolean;
    pendingLaunchAttempt?: NewSessionLaunchAttempt | null;
    /**
     * Whether the compact pending card is the active launch presentation,
     * resolved once by `resolveNewSessionLaunchPresentation`. This layout places
     * the card; it never re-decides, which is how a Temporary-computer request
     * used to end up with a pending card behind its own blocking surface.
     */
    launchPendingPreviewVisible?: boolean;
    providerLaunchError?: ProviderErrorV1 | null;
    retryProviderLaunch?: () => void;
    launchApproval?: NewSessionLaunchApprovalNoticeState | null;
    emptyAutocompleteKinds: React.ComponentProps<typeof AgentInput>['autocompleteKinds'];
    emptyAutocompleteSuggestions: React.ComponentProps<typeof AgentInput>['autocompleteSuggestions'];
    sessionPromptInputMaxHeight?: number;
    submitAccessibilityLabel?: React.ComponentProps<typeof AgentInput>['submitAccessibilityLabel'];
    agentInputExtraActionChips?: React.ComponentProps<typeof AgentInput>['extraActionChips'];
    /** Removable "continue from this Session" chip and its attachment row. */
    sourceContextPresentation?: AgentInputExtraActionPresentation | null;
    agentType: React.ComponentProps<typeof AgentInput>['agentType'];
    agentLabel?: React.ComponentProps<typeof AgentInput>['agentLabel'];
    handleAgentClick: React.ComponentProps<typeof AgentInput>['onAgentClick'];
    agentPickerTitle?: React.ComponentProps<typeof AgentInput>['agentPickerTitle'];
    agentPickerOptions?: React.ComponentProps<typeof AgentInput>['agentPickerOptions'];
    agentPickerSelectedOptionId?: React.ComponentProps<typeof AgentInput>['agentPickerSelectedOptionId'];
    onAgentPickerSelect?: React.ComponentProps<typeof AgentInput>['onAgentPickerSelect'];
    agentPickerApplyLabel?: React.ComponentProps<typeof AgentInput>['agentPickerApplyLabel'];
    agentPickerProbe?: React.ComponentProps<typeof AgentInput>['agentPickerProbe'];
    onAgentPickerVisibilityChange?: React.ComponentProps<typeof AgentInput>['onAgentPickerVisibilityChange'];
    permissionMode: React.ComponentProps<typeof AgentInput>['permissionMode'];
    allowedPermissionModes?: React.ComponentProps<typeof AgentInput>['allowedPermissionModes'];
    handlePermissionModeChange: React.ComponentProps<typeof AgentInput>['onPermissionModeChange'];
    modelMode: React.ComponentProps<typeof AgentInput>['modelMode'];
    setModelMode: React.ComponentProps<typeof AgentInput>['onModelModeChange'];
    modelOptions: ReadonlyArray<{ value: string; label: string; description: string }>;
    modelOptionsProbe?: React.ComponentProps<typeof AgentInput>['modelOptionsOverrideProbe'];
    /** Full-ref inputs for the canonical model picker in a host-bound creation surface. */
    modelPickerProps?: React.ComponentProps<typeof SessionModelPicker>;
    modelPickerPresentation?: React.ComponentProps<typeof AgentInput>['modelPickerPresentation'];
    modelContentOverride?: React.ComponentProps<typeof AgentInput>['modelContentOverride'];
    acpSessionModeOptions?: ReadonlyArray<Readonly<{ id: string; name: string; description?: string }>>;
    acpSessionModeProbe?: React.ComponentProps<typeof AgentInput>['acpSessionModeOptionsOverrideProbe'];
    acpSessionModeId?: string | null;
    setAcpSessionModeId?: (modeId: string | null) => void;
    acpConfigOptions?: React.ComponentProps<typeof AgentInput>['acpConfigOptionsOverride'];
    acpConfigOptionsProbe?: React.ComponentProps<typeof AgentInput>['acpConfigOptionsOverrideProbe'];
    acpConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
    setAcpConfigOptionOverride?: (configId: string, value: string) => void;
    connectionStatus: React.ComponentProps<typeof AgentInput>['connectionStatus'];
    statusBadges?: React.ComponentProps<typeof AgentInput>['statusBadges'];
    composerTopContent?: React.ReactNode;
    /** What the empty composer asks for; defaults to the ordinary session prompt. */
    inputPlaceholder?: string;
    /** Below the composer card (a seeded draft's provenance footnote). */
    composerBottomContent?: React.ReactNode;
    statusTrailingActions?: React.ComponentProps<typeof AgentInput>['statusTrailingActions'];
    machineName: string | undefined;
    machinePopover?: React.ComponentProps<typeof AgentInput>['machinePopover'];
    selectedPath: string;
    pathPopover?: React.ComponentProps<typeof AgentInput>['pathPopover'];
    /** The one folder chip's state (folder, no folder, loading, machine unavailable). */
    folderChipState?: React.ComponentProps<typeof AgentInput>['folderChipState'];
    onRemoveFolder?: () => void;
    showResumePicker: boolean;
    resumeSessionId: string | null;
    resumePopover?: React.ComponentProps<typeof AgentInput>['resumePopover'];
    isResumeSupportChecking: boolean;
    useProfiles: boolean;
    selectedProfileId: string | null;
    selectedMachineId?: string | null;
    isTemporaryComputer?: boolean;
    selectedMachineHomeDir?: string | null;
    profilePopover?: React.ComponentProps<typeof AgentInput>['profilePopover'];
    targetServerId?: string | null;
    attachmentFlowId?: string | null;
}>;

/**
 * The capsules at the end of the floating composer's status row: leave, and retract the keyboard
 * while it is up. They sit with the status line and the draft actions so the composer, its status
 * and its way out read as one cluster, not as a control floating above it.
 *
 * Its own component because the keyboard subscription has to run INSIDE the scaffold's layout
 * provider; read from the panel body it would resolve to a null context and the dismiss control
 * would never appear.
 */
const NewSessionFloatingComposerCapsules = React.memo(
    function NewSessionFloatingComposerCapsules(
        props: Readonly<{
            onClose: () => void;
            onDismissKeyboard: () => void;
        }>,
    ): React.ReactElement {
        const layout = useComposerKeyboardLayoutContext();
        const [isKeyboardOpen, setIsKeyboardOpen] = React.useState(false);

        React.useEffect(() => {
            const subscribe = layout?.subscribeKeyboardHeight;
            if (!subscribe) return undefined;
            // Height rather than a focus flag: focus is claimed before the keyboard is up and held
            // after it starts leaving, which would flash the control at both ends of the curve.
            return subscribe((height) => {
                setIsKeyboardOpen(height > 0);
            });
        }, [layout]);

        return (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: NEW_SESSION_CLOSE_BUTTON_GAP }}>
                {isKeyboardOpen ? (
                    <NewSessionComposerKeyboardDismissButton onPress={props.onDismissKeyboard} />
                ) : null}
                <NewSessionComposerCloseButton onPress={props.onClose} />
            </View>
        );
    },
);

/**
 * The floating composer's ground on web: the shared modal scrim over the whole window, at the
 * floating glass frost, so the composer, its status line and its actions sit directly on the
 * frosted page with no card around them. Native seats the card with `OverlayScrim`'s short band instead. Pressing it closes.
 */
function NewSessionWebFloatingBackdrop(props: Readonly<{ onPress: (() => void) | undefined }>): React.ReactElement {
    const { theme } = useUnistyles();
    const { blurEnabled } = useGlassBlurSetting();
    const scrimStyle = createModalScrimWebStyle({
        overlay: theme.colors.overlay as unknown as { scrim: string; scrimWizard?: string; scrimStrong?: string },
        enableBlur: blurEnabled,
        frost: 'floating',
    }) as unknown as ViewStyle;
    return (
        <Pressable
            testID="new-session-scrim"
            accessible={false}
            onPress={props.onPress}
            style={[RNStyleSheet.absoluteFill, scrimStyle]}
        />
    );
}

export function NewSessionSimplePanel(props: NewSessionSimplePanelProps): React.ReactElement {
    const { width: windowWidth } = useWindowDimensions();
    const shouldBottomAnchor =
        props.shouldBottomAnchor ?? (Platform.OS !== 'web' || isMobileLayoutWidth(windowWidth));
    const minimumTopGap = shouldBottomAnchor ? Math.min(props.newSessionTopPadding, SIMPLE_NEW_SESSION_MIN_TOP_GAP) : 0;

    // This screen is presented as a transparent modal, so it owns its own ground, its own entrance
    // and its own dismissal (web included, owner 2026-10-18).
    const isFloatingComposer = useNewSessionFloatingComposer();
    const router = useRouter();
    const navigation = useNavigation();
    const reducedMotion = useReducedMotionPreference();
    // Seeded settled for the non-floating case so the sheet path renders exactly as it did before.
    const enterProgress = useSharedValue(isFloatingComposer ? 0 : 1);
    const hasStartedEntranceRef = React.useRef(false);
    // Guards against a second dismiss landing while the first is still running.
    const isDismissingRef = React.useRef(false);
    const [isDismissing, setIsDismissing] = React.useState(false);
    const cardExitProgress = useSharedValue(1);

    // Self-heal: a dismissal that does not actually unmount this screen would otherwise leave the
    // composer permanently non-interactive — a far worse failure than the double tap the disarm
    // exists to prevent. The timer is cleared on unmount, so it only fires when the pop did not
    // happen.
    const dismissSafetyTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    React.useEffect(() => () => {
        if (dismissSafetyTimerRef.current !== null) clearTimeout(dismissSafetyTimerRef.current);
    }, []);

    // Started from the composer's FIRST LAYOUT, not from a mount effect. A mount effect fires while
    // this screen is still doing its (substantial) mount work and before the modal is presented, so
    // a fixed-duration animation was already finished by the time anything was on screen.
    const handleComposerEntranceLayout = React.useCallback(() => {
        if (!isFloatingComposer || hasStartedEntranceRef.current) return;
        hasStartedEntranceRef.current = true;
        if (reducedMotion) {
            enterProgress.value = 1;
            return;
        }
        // One frame after layout, not on the layout callback itself. Layout runs BEFORE
        // react-native-screens presents the modal — it defers the present to the next main-queue
        // turn precisely so children are laid out first — so starting here spent the opening frames
        // off screen and only the tail of the curve was ever visible.
        requestAnimationFrame(() => {
            enterProgress.value = withTiming(1, {
                duration: motionTokens.overlay.popover.enterMs,
                easing: reanimatedMotionTokens.easing.standard,
            });
        });
    }, [enterProgress, isFloatingComposer, reducedMotion]);

    const handleDismissKeyboard = React.useCallback(() => {
        Keyboard.dismiss();
    }, []);

    // Dismissal is deliberately NOT `Keyboard.dismiss()` + a fade. Dismissing the keyboard here
    // retracts it over its own ~250ms, and the keyboard seat drags the whole composer — including
    // the scrim — down with it. Translating three stacked masked blur layers forces an offscreen
    // re-composite every frame, and that is what tore the frost into horizontal bands on the way
    // out. The keyboard goes down anyway when the input unmounts.
    const handleDismissScreen = React.useCallback(() => {
        if (isDismissingRef.current) return;
        isDismissingRef.current = true;
        setIsDismissing(true);
        dismissSafetyTimerRef.current = setTimeout(() => {
            dismissSafetyTimerRef.current = null;
            isDismissingRef.current = false;
            cardExitProgress.value = 1;
            setIsDismissing(false);
        }, SIMPLE_NEW_SESSION_DISMISS_SAFETY_MS);

        const leave = () => {
            // `navigation` matters: without it `safeRouterBack` cannot use `navigation.goBack()` and
            // falls through to `router.back()`, which does not reliably settle a modal-stack
            // dismissal. The header close button this replaced always passed it, and dropping it is
            // what left `/new` lingering in the navigation state — so the next `push('/new')` was
            // deduped against a route that had not finished leaving, and the press did nothing.
            safeRouterBack({ router, navigation, fallbackHref: '/' });
            // AFTER the pop, never before: retracting the keyboard while this screen is still
            // mounted drags the composer — and the scrim's blur layers — down its curve.
            Keyboard.dismiss();
        };
        if (reducedMotion) {
            leave();
            return;
        }
        // Only the CARD animates out; the scrim is left where it is. Animating opacity on an
        // ancestor of the blur stack has the same offscreen-composite cost as moving it.
        cardExitProgress.value = withTiming(0, {
            duration: motionTokens.overlay.popover.exitMs,
            easing: reanimatedMotionTokens.easing.standard,
        }, (finished) => {
            if (finished) runOnJS(leave)();
        });
    }, [cardExitProgress, navigation, reducedMotion, router]);

    const isWebFloatingComposer = isFloatingComposer && Platform.OS === 'web';
    // The modal contract on a keyboard: Escape closes the floating composer (the draft is kept).
    // It is a modal layer like `BaseModal`'s; the composer's popovers and suggestions are scoped
    // under it (`EscapeLayerProvider` below), so they consume Escape first.
    const escapeLayer = useEscapeLayer({
        enabled: isFloatingComposer && !props.isCreating,
        priority: ESCAPE_LAYER_PRIORITIES.modal,
        allowEditableTarget: true,
        onEscape: () => {
            handleDismissScreen();
            return true;
        },
    });

    // Travel only, never opacity: the scrim carries the fade, and a card that never faded in cannot
    // be left invisible if the entrance is somehow missed — the blank-composer hazard
    // `ComposerKeyboardScaffold` warns about.
    // Rise plus a touch of scale. Travel alone reads as a panel being repositioned; the small scale
    // is what makes it read as a surface arriving. `fromScale` is the shared modal token rather than
    // a number invented here.
    const composerEnterStyle = useAnimatedStyle(() => {
        const settled = enterProgress.value;
        return {
            opacity: cardExitProgress.value,
            transform: [
                {
                    translateY: (1 - settled) * SIMPLE_NEW_SESSION_ENTER_TRAVEL_PX
                        + (1 - cardExitProgress.value) * SIMPLE_NEW_SESSION_EXIT_TRAVEL_PX,
                },
                { scale: SIMPLE_NEW_SESSION_ENTER_FROM_SCALE + (1 - SIMPLE_NEW_SESSION_ENTER_FROM_SCALE) * settled },
            ],
        };
    }, [cardExitProgress, enterProgress]);

    const composerReservedHeight = props.newSessionBottomPadding
        + (shouldBottomAnchor
            // The floating composer is bottom-anchored but still runs under the status bar and keeps
            // a capsule-high status row (leave, keyboard) above its input. Neither is subtracted
            // anywhere else, so without reserving them a long draft grows up through the status bar
            // and carries the only visible dismiss control off screen with it.
            ? (isFloatingComposer ? props.safeAreaTop + NEW_SESSION_CLOSE_ROW_HEIGHT : 0)
            : props.safeAreaTop + props.newSessionTopPadding);
    // A centred desktop composer closes from its frosted ground and Escape; the capsules belong to the
    // bottom-anchored (touch) composition and ride the status row the card already draws.
    const cardPanelProps = isFloatingComposer && shouldBottomAnchor
        ? {
            ...props,
            statusTrailingActions: (
                <>
                    {props.statusTrailingActions}
                    <NewSessionFloatingComposerCapsules
                        onClose={handleDismissScreen}
                        onDismissKeyboard={handleDismissKeyboard}
                    />
                </>
            ),
        }
        : props;
    const showPendingLaunchPreview = props.launchPendingPreviewVisible === true
        && props.pendingLaunchAttempt != null;
    // A bottom-anchored composer leaves the screen above it to the card; a centred desktop composer
    // has no such region (its content area is zero-height), so there the card sits in the composer
    // column, directly above the composer, and can never cover it.
    const pendingLaunchPreview = showPendingLaunchPreview ? (
        <View
            style={{
                width: '100%',
                alignSelf: 'stretch',
                paddingHorizontal: props.newSessionSidePadding,
                paddingBottom: 8,
            }}
        >
            <View style={{ maxWidth: layout.maxWidth, width: '100%', alignSelf: 'center' }}>
                <NewSessionLaunchPendingPreview launchAttempt={props.pendingLaunchAttempt} />
            </View>
        </View>
    ) : null;
    const shellStyle = [
        props.containerStyle,
        ...(shouldBottomAnchor
            ? [
                {
                    justifyContent: 'flex-end' as const,
                    paddingTop: 0,
                },
            ]
            : [
                {
                    // A desktop floating composer sits in the middle of the frosted window, where
                    // the route card used to.
                    justifyContent: isWebFloatingComposer ? 'center' as const : 'flex-start' as const,
                    paddingTop: 0,
                },
            ]),
        // The WHOLE modal stops hit-testing the instant dismissal starts, not just the backdrop.
        // This screen is a presented view controller whose root covers the display, so every view
        // inside it claims a touch while it is still mounted, and the exit animation keeps it
        // mounted after the card has visually gone. Disarming only the backdrop left the rest of
        // that surface swallowing the first press on the tab bar underneath.
        isFloatingComposer && isDismissing ? { pointerEvents: 'none' as const } : null,
        // On web the scaffold spans the window above the frosted backdrop: only its content takes
        // presses, so a press beside the composer reaches the backdrop and closes.
        isWebFloatingComposer && !isDismissing ? { pointerEvents: 'box-none' as const } : null,
    ];
    return (
        <EscapeLayerProvider layer={escapeLayer}>
        {isWebFloatingComposer ? (
            <NewSessionWebFloatingBackdrop onPress={props.isCreating ? undefined : handleDismissScreen} />
        ) : null}
        <ComposerKeyboardScaffold
            testID="new-session-keyboard-host"
            mode="newSession"
            contentTestID="new-session-keyboard-content"
            composerTestID="new-session-composer-keyboard-host"
            // `useHeaderHeight()` is a platform constant, not a measurement, so it still reports a
            // header the floating presentation does not draw. Left as-is it subtracts ~44pt of
            // phantom chrome from the keyboard layout's bootstrap viewport.
            headerHeight={isFloatingComposer ? 0 : props.headerHeight}
            // The scaffold resolves the composer's resting offset as max(keyboardHeight,
            // safeAreaBottom). A floating card is not seated against the screen edge, so the
            // home-indicator inset is the wrong resting gap — it leaves the card sitting visibly
            // higher than its own side margin. The composer wrapper already pads
            // `newSessionBottomPadding` below the card, so only the remainder belongs here. The
            // keyboard is always taller than that remainder, so keyboard-open positioning is
            // unchanged.
            safeAreaBottom={isFloatingComposer
                ? Math.max(0, props.newSessionSidePadding - props.newSessionBottomPadding)
                : props.safeAreaBottom}
            style={shellStyle}
            contentStyle={
                shouldBottomAnchor
                    ? undefined
                    : {
                        flexBasis: 0,
                        flexGrow: 0,
                    }
            }
            surface={isFloatingComposer ? 'transparent' : undefined}
            composer={(
                <PopoverBoundaryProvider boundaryRef={props.popoverBoundaryRef}>
                    <Animated.View
                        onLayout={isFloatingComposer ? handleComposerEntranceLayout : undefined}
                        style={[
                            {
                                width: '100%',
                                alignSelf: 'center',
                            },
                            // The entrance lives on this view, NOT on the scaffold's composer
                            // wrapper: that wrapper carries the keyboard seat (translateY =
                            // -bottomInset, written by the keyboard worklets), and the two
                            // transforms must compose rather than compete for one style.
                            isFloatingComposer ? composerEnterStyle : null,
                        ]}
                    >
                        {/*
                          * The scrim is anchored to the CARD, not to the slot. Anchoring it to the
                          * slot measured its ramp from the top of the close capsule, which put the
                          * band a capsule-plus-gap higher than the edge it is supposed to seat.
                          */}
                        <View>
                        {shouldBottomAnchor ? null : pendingLaunchPreview}
                        {isFloatingComposer && !isWebFloatingComposer ? (
                            <OverlayScrim
                                progress={enterProgress}
                                rampHeight={SIMPLE_NEW_SESSION_SCRIM_RAMP_HEIGHT}
                                testID="new-session-scrim"
                            />
                        ) : null}
                        <NewSessionComposerCard
                            panelProps={cardPanelProps}
                            layout="screen"
                            reservedHeight={composerReservedHeight}
                        />
                        </View>
                    </Animated.View>
                </PopoverBoundaryProvider>
            )}
        >
            <View
                ref={props.popoverBoundaryRef}
                style={{
                    flex: 1,
                    width: '100%',
                    justifyContent: shouldBottomAnchor ? 'flex-end' : 'flex-start',
                }}
            >
                {shouldBottomAnchor ? (
                    // In the floating presentation this region IS the visible backdrop, so tapping
                    // it closes the composer — the modal contract, and the only dismiss target on
                    // Android, where a transparent presentation catches nothing by default. The
                    // draft survives: losing focus flushes any pending persist. While a launch is
                    // in flight this region hosts the pending preview instead, and a stray tap must
                    // not throw away the feedback the user is waiting on.
                    <Pressable
                        accessible={false}
                        style={{ flex: 1, width: '100%', minHeight: minimumTopGap }}
                        onPress={isFloatingComposer && !props.isCreating ? handleDismissScreen : handleDismissKeyboard}
                    />
                ) : null}
                {shouldBottomAnchor ? pendingLaunchPreview : null}
            </View>
        </ComposerKeyboardScaffold>
        </EscapeLayerProvider>
    );
}
