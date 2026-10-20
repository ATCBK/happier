import * as React from 'react';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';
import { useSetting } from '@/sync/domains/state/storage';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { TOOL_DETAIL_LEVEL_WITH_DEFAULT_OPTIONS } from '@/components/settings/session/toolRendering/toolRenderingSettingOptions';
import { TOOL_RENDERING_OVERRIDE_ENTRIES } from '@/components/settings/session/toolRendering/toolRenderingOverrideEntries';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { TOOL_RENDERING_SETTINGS } from '@/components/settings/session/toolRenderingSettings';

type ExpandedOverride = 'default' | 'summary' | 'full';

export const ToolRenderingSettingsView = React.memo(function ToolRenderingSettingsView() {
    const popoverBoundaryRef = React.useRef<React.ComponentRef<typeof ItemList>>(null);

    const toolViewDetailLevelByToolName = useSetting('toolViewDetailLevelByToolName');
    const toolViewExpandedDetailLevelByToolName = useSetting('toolViewExpandedDetailLevelByToolName');
    const { setSetting } = useSettingActionFeedback();

    const [openToolDetailMenu, setOpenToolDetailMenu] = React.useState<null | string>(null);
    // One row per tool: the section says what the choice means, so the rows carry only the value.
    const expandedOptions = React.useMemo(() => [
        { id: 'default' as const, label: t('settingsSession.toolDetailLevel.defaultTitle') },
        { id: 'summary' as const, label: t('settingsSession.toolDetailLevel.summaryTitle') },
        { id: 'full' as const, label: t('settingsSession.toolDetailLevel.fullTitle') },
    ], []);

    return (
        <ItemList ref={popoverBoundaryRef} style={{ paddingTop: 0 }}>
            <SettingsPageHeader description={t('settingsSessionPages.toolRendering.pageDescription')} />
            <SettingAnchor setting={TOOL_RENDERING_SETTINGS.settings.collapsedOverrides}>
                <ItemGroup
                    title={t('settingsSession.toolDetailOverrides.title')}
                    description={t('settingsSessionPages.toolRendering.collapsedDescription')}
                >
                    {TOOL_RENDERING_OVERRIDE_ENTRIES.map((toolKey) => {
                        const override = toolViewDetailLevelByToolName[toolKey.toolName];
                        const selected = override ?? 'default';

                        return (
                            <DropdownMenu
                                key={toolKey.toolName}
                                open={openToolDetailMenu === `toolOverride:${toolKey.toolName}`}
                                onOpenChange={(next) => setOpenToolDetailMenu(next ? `toolOverride:${toolKey.toolName}` : null)}
                                variant="selectable"
                                search={false}
                                selectedId={selected}
                                showCategoryTitles={false}
                                matchTriggerWidth={true}
                                connectToTrigger={true}
                                rowKind="item"
                                popoverBoundaryRef={popoverBoundaryRef}
                                itemTrigger={{
                                    title: toolKey.title,
                                    showSelectedSubtitle: false,
                                    itemProps: { testID: `settings-tool-rendering-collapsed-${toolKey.toolName}` },
                                }}
                                items={TOOL_DETAIL_LEVEL_WITH_DEFAULT_OPTIONS.map((opt) => ({
                                    id: opt.key,
                                    title: t(opt.titleKey),
                                    subtitle: t(opt.subtitleKey),
                                }))}
                                onSelect={(id) => {
                                    const option = TOOL_DETAIL_LEVEL_WITH_DEFAULT_OPTIONS.find(candidate => candidate.key === id);
                                    if (!option) return;
                                    void setSetting(TOOL_RENDERING_SETTINGS.settings.collapsedOverrides,
                                        { toolName: toolKey.toolName, detailLevel: option.key });
                                    setOpenToolDetailMenu(null);
                                }}
                            />
                        );
                    })}
                </ItemGroup>
            </SettingAnchor>

            <SettingAnchor setting={TOOL_RENDERING_SETTINGS.settings.expandedOverrides}>
                <ItemGroup
                    title={t('settingsSession.toolDetailOverrides.expandedTitle')}
                    description={t('settingsSession.toolDetailOverrides.expandedFooter')}
                >
                    {TOOL_RENDERING_OVERRIDE_ENTRIES.map((toolKey) => {
                        const override = toolViewExpandedDetailLevelByToolName[toolKey.toolName];
                        return (
                            <SegmentedChoiceItem<ExpandedOverride>
                                key={toolKey.toolName}
                                testID={`settings-tool-rendering-expanded-${toolKey.toolName}`}
                                testIDPrefix={`settings-tool-rendering-expanded-${toolKey.toolName}`}
                                title={toolKey.title}
                                options={expandedOptions}
                                value={override ?? 'default'}
                                onChange={(next) => { void setSetting(TOOL_RENDERING_SETTINGS.settings.expandedOverrides,
                                    { toolName: toolKey.toolName, detailLevel: next }); }}
                            />
                        );
                    })}
                </ItemGroup>
            </SettingAnchor>
        </ItemList>
    );
});

export default ToolRenderingSettingsView;
