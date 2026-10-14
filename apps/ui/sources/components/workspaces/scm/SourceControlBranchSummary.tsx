import * as React from 'react';
import { Platform, View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { ScmStatusFiles } from '@/scm/scmStatusFiles';
import { Icon } from '@/components/ui/icons/Icon';

type SourceControlBranchSummaryProps = {
    theme: any;
    scmStatusFiles: ScmStatusFiles;
    variant?: 'screen' | 'rail';
    backendLabel?: string;
    branchTrigger?: React.ReactNode;
    actionSlot?: React.ReactNode;
};

function readThemeToken(theme: any, path: readonly string[]): unknown {
    let value = theme;
    for (const segment of path) {
        if (value == null || typeof value !== 'object') return undefined;
        value = value[segment];
    }
    return value;
}

function areBranchSummaryThemeTokensEqual(previous: any, next: any): boolean {
    const tokenPaths: readonly (readonly string[])[] = [
        ['colors', 'border', 'default'],
        ['colors', 'input', 'background'],
        ['colors', 'surface', 'base'],
        ['colors', 'surface', 'inset'],
        ['colors', 'text', 'primary'],
        ['colors', 'text', 'secondary'],
        ['space', 's4'],
        ['space', 's6'],
        ['space', 's8'],
        ['space', 's10'],
        ['space', 's12'],
        ['space', 's16'],
    ];
    return tokenPaths.every((path) => Object.is(readThemeToken(previous, path), readThemeToken(next, path)));
}

function normalizeSummaryNumber(value: unknown): number {
    return Number(value ?? 0);
}

function areScmStatusFileSummariesEqual(previous: ScmStatusFiles, next: ScmStatusFiles): boolean {
    return previous.branch === next.branch
        && (previous.upstream ?? null) === (next.upstream ?? null)
        && normalizeSummaryNumber(previous.ahead) === normalizeSummaryNumber(next.ahead)
        && normalizeSummaryNumber(previous.behind) === normalizeSummaryNumber(next.behind)
        && normalizeSummaryNumber(previous.totalIncluded) === normalizeSummaryNumber(next.totalIncluded)
        && normalizeSummaryNumber(previous.totalPending) === normalizeSummaryNumber(next.totalPending)
        && (previous.changeSetModel ?? null) === (next.changeSetModel ?? null);
}

function areSourceControlBranchSummaryPropsEqual(
    previous: SourceControlBranchSummaryProps,
    next: SourceControlBranchSummaryProps,
): boolean {
    return previous.variant === next.variant
        && previous.backendLabel === next.backendLabel
        && previous.branchTrigger === next.branchTrigger
        && previous.actionSlot === next.actionSlot
        && areBranchSummaryThemeTokensEqual(previous.theme, next.theme)
        && areScmStatusFileSummariesEqual(previous.scmStatusFiles, next.scmStatusFiles);
}

/**
 * Module scope, not render-body components: declared inside the summary they would be new component
 * types on every SCM status update, so React would remount every pill and stat instead of updating
 * them. This surface re-renders on each status push, which is exactly when that cost lands.
 */
function StatPill(props: Readonly<{
    label: string;
    value: number;
    iconName: string;
    theme: SourceControlBranchSummaryProps['theme'];
}>) {
    const { theme } = props;
    return (
        <View
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: theme.space.s6,
                paddingHorizontal: theme.space.s10,
                paddingVertical: theme.space.s6,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: theme.colors.border.default,
                backgroundColor: theme.colors.surface.inset ?? theme.colors.input.background,
            }}
        >
            <Icon name={props.iconName as any} size={14} color={theme.colors.text.secondary} />
            <Text style={{ ...Typography.variant('meta', 'semiBold'), color: theme.colors.text.secondary,  }}>
                {props.label}
            </Text>
            <Text style={{ fontSize: 12, color: theme.colors.text.primary, ...Typography.mono('semiBold') }}>
                {String(props.value)}
            </Text>
        </View>
    );
}

function InlineStat(props: Readonly<{
    label: string;
    value: number;
    iconName: string;
    theme: SourceControlBranchSummaryProps['theme'];
}>) {
    const { theme } = props;
    return (
        <View
            accessible
            accessibilityLabel={`${props.label}: ${props.value}`}
            {...(Platform.OS === 'web' ? { title: `${props.label}: ${props.value}` } : {})}
            style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s4 }}
        >
            <Icon name={props.iconName as any} size={14} color={theme.colors.text.secondary} />
            <Text style={{ fontSize: 11, color: theme.colors.text.primary, ...Typography.mono('semiBold') }}>
                {String(props.value)}
            </Text>
        </View>
    );
}

function SourceControlBranchSummaryImpl({
    theme,
    scmStatusFiles,
    variant = 'screen',
    backendLabel,
    branchTrigger,
    actionSlot,
}: SourceControlBranchSummaryProps) {
    const ahead = Number(scmStatusFiles.ahead ?? 0);
    const behind = Number(scmStatusFiles.behind ?? 0);
    const showTracking = Boolean(scmStatusFiles.upstream) || ahead > 0 || behind > 0;
    const staged = Number(scmStatusFiles.totalIncluded ?? 0);
    const unstaged = Number(scmStatusFiles.totalPending ?? 0);
    const usesWorkingCopyModel = scmStatusFiles.changeSetModel === 'working-copy';
    const includedLabel = usesWorkingCopyModel ? t('files.branchSummary.included') : t('files.branchSummary.staged');
    const pendingLabel = usesWorkingCopyModel ? t('files.branchSummary.pending') : t('files.branchSummary.unstaged');

    const isRail = variant === 'rail';
    if (variant === 'rail') {
        return (
            <View
                style={{
                    paddingHorizontal: theme.space.s12,
                    paddingTop: theme.space.s6,
                    paddingBottom: theme.space.s6,
                    borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                    borderBottomColor: theme.colors.border.default,
                    backgroundColor: theme.colors.surface.base,
                    gap: theme.space.s6,
                }}
            >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 }}>
                    <View style={{ minWidth: 0, flex: 1 }}
                        accessibilityHint={scmStatusFiles.upstream ?? undefined}
                        {...(Platform.OS === 'web' ? { title: scmStatusFiles.upstream ? `${scmStatusFiles.branch ?? ''} · ${scmStatusFiles.upstream}` : scmStatusFiles.branch ?? undefined } : {})}
                    >
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s8, minWidth: 0 }}>
                            <Icon
                                name="git-branch"
                                size={14}
                                color={theme.colors.text.secondary}
                                style={{ flexShrink: 0 }}
                            />
                            {branchTrigger ? (
                                <View style={{ minWidth: 0, flexShrink: 1 }}>
                                    {branchTrigger}
                                </View>
                            ) : (
                                <Text
                                    numberOfLines={1}
                                    style={{
                                        flexShrink: 1,
                                        minWidth: 0,
                                        ...Typography.variant('label', 'semiBold'),
                                        color: theme.colors.text.primary,
                                    }}
                                >
                                    {scmStatusFiles.branch || t('files.detachedHead')}
                                </Text>
                            )}
                        {backendLabel ? (
                            <Text testID="scm-backend-label" accessibilityRole="text" numberOfLines={1}
                                style={{ flexShrink: 1, minWidth: 0, ...Typography.variant('micro', 'semiBold'), color: theme.colors.text.secondary,  }}>
                                {backendLabel}
                            </Text>
                        ) : null}
                        </View>
                    </View>

                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s8, flexShrink: 0 }}>
                        {actionSlot}
                        <InlineStat label={includedLabel} value={staged} iconName="plus-square" theme={theme} />
                        <InlineStat label={pendingLabel} value={unstaged} iconName="pencil-simple" theme={theme} />
                        {showTracking ? <InlineStat label={t('files.branchSummary.ahead')} value={ahead} iconName="arrow-up" theme={theme} /> : null}
                        {showTracking ? <InlineStat label={t('files.branchSummary.behind')} value={behind} iconName="arrow-down" theme={theme} /> : null}
                    </View>
                </View>

            </View>
        );
    }

    return (
        <View
            style={{
                padding: theme.space.s16,
                borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                borderBottomColor: theme.colors.border.default,
            }}
        >
            <View
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    marginBottom: theme.space.s8,
                }}
            >
                <Icon name="git-branch" size={16} color={theme.colors.text.secondary} style={{ marginRight: theme.space.s6 }} />
                <Text
                    style={{
                        ...Typography.variant('heading'),
                        color: theme.colors.text.primary,
                    }}
                >
                    {scmStatusFiles.branch || t('files.detachedHead')}
                </Text>
                {backendLabel ? (
                    <Text
                        testID="scm-backend-label"
                        accessibilityRole="text"
                        numberOfLines={1}
                        style={{
                            marginLeft: theme.space.s8,
                            ...Typography.variant('meta', 'semiBold'),
                            color: theme.colors.text.secondary,
                        }}
                    >
                        {backendLabel}
                    </Text>
                ) : null}
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s8 }}>
                <StatPill label={includedLabel} value={staged} iconName="plus-square" theme={theme} />
                <StatPill label={pendingLabel} value={unstaged} iconName="pencil-simple" theme={theme} />
                {showTracking && (
                    <StatPill label={t('files.branchSummary.ahead')} value={ahead} iconName="arrow-up" theme={theme} />
                )}
                {showTracking && (
                    <StatPill label={t('files.branchSummary.behind')} value={behind} iconName="arrow-down" theme={theme} />
                )}
            </View>

            {showTracking && (
                <Text
                    style={{
                        marginTop: theme.space.s4,
                        ...Typography.variant('meta'),
                        color: theme.colors.text.secondary,
                    }}
                >
                    {scmStatusFiles.upstream
                        ? t('files.branchSummary.upstreamLabel', { upstream: scmStatusFiles.upstream })
                        : t('files.branchSummary.noUpstream')}
                </Text>
            )}
        </View>
    );
}

export const SourceControlBranchSummary = React.memo(
    SourceControlBranchSummaryImpl,
    areSourceControlBranchSummaryPropsEqual,
);
SourceControlBranchSummary.displayName = 'SourceControlBranchSummary';
