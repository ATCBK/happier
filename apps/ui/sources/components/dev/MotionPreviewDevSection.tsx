import { Typography } from '@/constants/Typography';
import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { Icon } from '@/components/ui/icons/Icon';
import {
    SlideTransitionSwitch,
    SoftSlideTransitionFrame,
    type SlideTransitionRole,
} from '@/components/ui/motion';

type VariantState = Readonly<{
    blur: boolean;
    preset: SlideTransitionRole;
    reducedMotion: boolean;
}>;

function ToggleRow(props: Readonly<{
    label: string;
    value: boolean;
    onChange: (next: boolean) => void;
}>): React.ReactElement {
    return (
        <Pressable
            onPress={() => props.onChange(!props.value)}
            style={styles.toggleRow}
        >
            <Text style={styles.toggleLabel}>{props.label}</Text>
            <Text style={styles.toggleValue}>{props.value ? 'on' : 'off'}</Text>
        </Pressable>
    );
}

function PresetRow(props: Readonly<{
    value: SlideTransitionRole;
    onChange: (next: SlideTransitionRole) => void;
}>): React.ReactElement {
    return (
        <Pressable
            onPress={() => props.onChange(props.value === 'signature' ? 'routine' : 'signature')}
            style={styles.toggleRow}
        >
            <Text style={styles.toggleLabel}>preset</Text>
            <Text style={styles.toggleValue}>{props.value}</Text>
        </Pressable>
    );
}

function VariantControls(props: Readonly<{
    state: VariantState;
    onChange: (next: VariantState) => void;
}>): React.ReactElement {
    return (
        <View style={styles.controlsRow}>
            <ToggleRow
                label="blur"
                value={props.state.blur}
                onChange={(blur) => props.onChange({ ...props.state, blur })}
            />
            <PresetRow
                value={props.state.preset}
                onChange={(preset) => props.onChange({ ...props.state, preset })}
            />
            <ToggleRow
                label="reduced motion"
                value={props.state.reducedMotion}
                onChange={(reducedMotion) => props.onChange({ ...props.state, reducedMotion })}
            />
        </View>
    );
}

function DiscreteSwitchVariant(): React.ReactElement {
    const [index, setIndex] = React.useState(0);
    const previousIndexRef = React.useRef(0);
    const [variant, setVariant] = React.useState<VariantState>({
        blur: false,
        preset: 'routine',
        reducedMotion: false,
    });

    const direction = React.useMemo(() => {
        const previous = previousIndexRef.current;
        previousIndexRef.current = index;
        if (index > previous) return 'forward' as const;
        if (index < previous) return 'backward' as const;
        return 'replace' as const;
    }, [index]);

    return (
        <View style={styles.variantBlock}>
            <Text style={styles.variantTitle}>Discrete switch (SelectionList-style)</Text>
            <VariantControls state={variant} onChange={setVariant} />
            <View style={styles.frame}>
                <SlideTransitionSwitch
                    contentKey={index}
                    direction={direction}
                    blur={variant.blur}
                    preset={variant.preset}
                    reducedMotion={variant.reducedMotion}
                >
                    <View style={styles.panel}>
                        <Text style={styles.panelTitle}>{`Step ${index + 1}`}</Text>
                        <Text style={styles.panelBody}>
                            Discrete adapter for SelectionList. Forward/backward direction is caller-owned; blur defaults off.
                        </Text>
                    </View>
                </SlideTransitionSwitch>
            </View>
            <View style={styles.controlsRow}>
                <Pressable
                    onPress={() => setIndex((current) => Math.max(0, current - 1))}
                    style={styles.button}
                >
                    <Text style={styles.buttonText}>Back</Text>
                </Pressable>
                <Pressable
                    onPress={() => setIndex((current) => Math.min(4, current + 1))}
                    style={styles.button}
                >
                    <Text style={styles.buttonText}>Forward</Text>
                </Pressable>
            </View>
        </View>
    );
}

function CarouselVariant(): React.ReactElement {
    const [activeIndex, setActiveIndex] = React.useState(0);
    const [variant, setVariant] = React.useState<VariantState>({
        blur: true,
        preset: 'signature',
        reducedMotion: false,
    });
    const itemCount = 5;
    const previousIndexRef = React.useRef(0);
    const direction = React.useMemo(() => {
        const previous = previousIndexRef.current;
        previousIndexRef.current = activeIndex;
        if (activeIndex > previous) return 'forward' as const;
        if (activeIndex < previous) return 'backward' as const;
        return 'replace' as const;
    }, [activeIndex]);

    const commitNext = React.useCallback(() => {
        setActiveIndex((current) => Math.min(itemCount - 1, current + 1));
    }, [itemCount]);

    const commitPrevious = React.useCallback(() => {
        setActiveIndex((current) => Math.max(0, current - 1));
    }, []);

    return (
        <View style={styles.variantBlock}>
            <Text style={styles.variantTitle}>Carousel drag + tap (StoryDeck-style)</Text>
            <VariantControls state={variant} onChange={setVariant} />
            <View style={styles.frame}>
                <SlideTransitionSwitch
                    contentKey={activeIndex}
                    direction={direction}
                    blur={variant.blur}
                    preset={variant.preset}
                    reducedMotion={variant.reducedMotion}
                >
                    <View style={styles.panel} testID="dev-motion-preview-carousel">
                        <Text testID="dev-motion-preview-carousel-title" style={styles.panelTitle}>{`Card ${activeIndex + 1}`}</Text>
                        <Text style={styles.panelBody}>
                            Use Continue/Back to exercise the same transition direction contract as card-style flows.
                        </Text>
                    </View>
                </SlideTransitionSwitch>
            </View>
            <View style={styles.controlsRow}>
                <Pressable
                    testID="dev-motion-preview-carousel-back"
                    onPress={commitPrevious}
                    style={styles.button}
                >
                    <Text style={styles.buttonText}>Back</Text>
                </Pressable>
                <Pressable
                    testID="dev-motion-preview-carousel-continue"
                    onPress={commitNext}
                    style={styles.button}
                >
                    <Text style={styles.buttonText}>Continue</Text>
                </Pressable>
            </View>
        </View>
    );
}

/** The wizard/onboarding step frame: signature (blurred, slower) vs routine (plain, quick). */
function StepTransitionVariant(): React.ReactElement {
    const [index, setIndex] = React.useState(0);
    const [direction, setDirection] = React.useState<'forward' | 'backward'>('forward');
    const [preset, setPreset] = React.useState<SlideTransitionRole>('signature');
    const [reducedMotion, setReducedMotion] = React.useState(false);

    return (
        <View style={styles.variantBlock}>
            <Text style={styles.variantTitle}>Step transition (wizard-style)</Text>
            <View style={styles.controlsRow}>
                <Pressable
                    testID="dev-motion-preview-step-preset"
                    onPress={() => setPreset((current) => (current === 'signature' ? 'routine' : 'signature'))}
                    style={styles.toggleRow}
                >
                    <Text style={styles.toggleLabel}>preset</Text>
                    <Text style={styles.toggleValue}>{preset}</Text>
                </Pressable>
                <ToggleRow label="reduced motion" value={reducedMotion} onChange={setReducedMotion} />
            </View>
            <View style={styles.frame}>
                <SoftSlideTransitionFrame
                    testID="dev-motion-preview-step-frame"
                    transitionKey={index}
                    direction={direction}
                    preset={preset}
                    reducedMotion={reducedMotion}
                >
                    <View style={styles.panel}>
                        <Text testID="dev-motion-preview-step-title" style={styles.panelTitle}>{`Step ${index + 1}`}</Text>
                        <Text style={styles.panelBody}>
                            Signature is for the first moments of a flow; routine is for everyday step changes and recovery views.
                        </Text>
                    </View>
                </SoftSlideTransitionFrame>
            </View>
            <View style={styles.controlsRow}>
                <Pressable
                    testID="dev-motion-preview-step-back"
                    onPress={() => {
                        setDirection('backward');
                        setIndex((current) => Math.max(0, current - 1));
                    }}
                    style={styles.button}
                >
                    <Text style={styles.buttonText}>Back</Text>
                </Pressable>
                <Pressable
                    testID="dev-motion-preview-step-continue"
                    onPress={() => {
                        setDirection('forward');
                        setIndex((current) => Math.min(4, current + 1));
                    }}
                    style={styles.button}
                >
                    <Text style={styles.buttonText}>Continue</Text>
                </Pressable>
            </View>
        </View>
    );
}

function MotionVariantsPreviewModal(props: Readonly<{ onClose: () => void }>): React.ReactElement {
    const { theme } = useUnistyles();
    return (
        <View style={styles.modal}>
            <View style={styles.header}>
                <Text style={styles.headerTitle}>Motion primitives - variants</Text>
                <Pressable onPress={props.onClose} style={styles.closeButton}>
                    <Icon name="x" size={20} color={theme.colors.text.primary} />
                </Pressable>
            </View>
            <ScrollView style={styles.bodyScroll} contentContainerStyle={styles.body}>
                <DiscreteSwitchVariant />
                <CarouselVariant />
                <StepTransitionVariant />
            </ScrollView>
        </View>
    );
}

function showMotionVariantsPreview(): void {
    let id: string | null = null;
    const close = () => {
        if (!id) return;
        Modal.hide(id);
        id = null;
    };
    id = Modal.show({
        component: MotionVariantsPreviewModal,
        props: { onClose: close },
    });
}

export function MotionPreviewDevSection(): React.ReactElement {
    const { theme } = useUnistyles();
    return (
        <ItemGroup title="Motion Primitives" description="Slide transition variants for visual QA">
            <Item
                testID="dev-motion-preview-slide-variants"
                title="Slide Transition Variants"
                subtitle="Discrete switch, carousel drag/tap and step signature/routine, with blur/preset/reduced-motion toggles"
                icon={<Icon name="stack-simple" size={29} color={theme.colors.text.primary} />}
                onPress={showMotionVariantsPreview}
            />
        </ItemGroup>
    );
}

const styles = StyleSheet.create((theme) => ({
    modal: {
        flex: 1,
        backgroundColor: theme.colors.background.canvas,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s12,
    },
    headerTitle: {
        color: theme.colors.text.primary,
        fontSize: 18,
        fontWeight: '600',
    },
    closeButton: {
        padding: theme.space.s8,
    },
    bodyScroll: {
        flex: 1,
    },
    body: {
        gap: theme.space.s24,
        padding: theme.space.s16,
    },
    variantBlock: {
        gap: theme.space.s12,
    },
    variantTitle: {
        color: theme.colors.text.primary,
        ...Typography.variant('label', 'semiBold'),
    },
    controlsRow: {
        flexDirection: 'row',
        gap: theme.space.s8,
        flexWrap: 'wrap',
    },
    toggleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        paddingHorizontal: theme.space.s10,
        paddingVertical: theme.space.s6,
        backgroundColor: theme.colors.surface.elevated,
        borderRadius: 999,
    },
    toggleLabel: {
        color: theme.colors.text.secondary,
        fontSize: 12,
    },
    toggleValue: {
        color: theme.colors.text.primary,
        ...Typography.variant('meta', 'semiBold'),
    },
    frame: {
        height: 260,
        backgroundColor: theme.colors.surface.inset,
        borderRadius: 12,
        overflow: 'hidden',
    },
    panel: {
        flex: 1,
        gap: theme.space.s8,
        padding: theme.space.s16,
        backgroundColor: theme.colors.surface.base,
    },
    panelTitle: {
        color: theme.colors.text.primary,
        fontSize: 16,
        fontWeight: '700',
    },
    panelBody: {
        color: theme.colors.text.secondary,
        fontSize: 13,
        lineHeight: 18,
    },
    button: {
        paddingHorizontal: 14,
        paddingVertical: theme.space.s8,
        backgroundColor: theme.colors.button.primary.background,
        borderRadius: 8,
    },
    buttonText: {
        color: theme.colors.button.primary.tint,
        ...Typography.variant('body', 'semiBold'),
    },
}));
