import * as React from 'react';

import { Switch } from '@/components/ui/forms/Switch';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useSetting, useSettingMutable } from '@/sync/domains/state/storage';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import {
    NEW_SESSION_WIZARD_SELECTION_SECTION_IDS,
    type NewSessionWizardSectionPresentation,
    type NewSessionWizardSelectionSectionId,
} from '@/sync/domains/settings/registry/account/accountSessionCreationSettingDefinitions';
import { t } from '@/text';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingAnchor, SettingRow } from '@/components/settings/shell/SettingRow';
import { NEW_SESSION_WIZARD_SETTINGS } from '@/components/settings/session/newSessionWizardSettings';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';

const STEP_IDS = ['profiles', 'backends', 'models', 'machines', 'paths', 'permissions'] as const satisfies readonly NewSessionWizardSelectionSectionId[];

function isWizardPresentation(value: string): value is NewSessionWizardSectionPresentation {
    return value === 'auto' || value === 'list' || value === 'dropdown';
}

function WizardStepPresentationRow(props: Readonly<{
    stepId: (typeof STEP_IDS)[number];
    value: NewSessionWizardSectionPresentation;
    onChange: (stepId: NewSessionWizardSelectionSectionId, value: NewSessionWizardSectionPresentation) => void;
}>) {
    const setting = NEW_SESSION_WIZARD_SETTINGS.settings[props.stepId];
    return (
        <SettingAnchor setting={setting}>
            <SegmentedChoiceItem
                testID={`settings-new-session-wizard-${props.stepId}`}
                title={t(setting.titleKey)}
                // The section says what each layout means; six rows repeating it would be noise.
                options={[
                    { id: 'auto', label: t('settingsSession.sessionCreation.wizardPresentationAutoTitle') },
                    { id: 'list', label: t('settingsSession.sessionCreation.wizardPresentationListTitle') },
                    { id: 'dropdown', label: t('settingsSession.sessionCreation.wizardPresentationDropdownTitle') },
                ]}
                value={props.value}
                onChange={(itemId) => {
                    if (!isWizardPresentation(itemId)) return;
                    props.onChange(props.stepId, itemId);
                }}
            />
        </SettingAnchor>
    );
}

export const NewSessionWizardSettingsView = React.memo(function NewSessionWizardSettingsView() {
    const presentationBySection = useSetting('newSessionWizardSectionPresentationV1');
    const [columnsEnabled, setColumnsEnabled] = useSettingMutable('newSessionWizardColumnsEnabled');
    const { setSetting } = useSettingActionFeedback();

    const normalizedPresentationBySection = React.useMemo(() => {
        const record = presentationBySection && typeof presentationBySection === 'object' && !Array.isArray(presentationBySection)
            ? presentationBySection as Partial<Record<NewSessionWizardSelectionSectionId, NewSessionWizardSectionPresentation>>
            : {};
        return Object.fromEntries(
            NEW_SESSION_WIZARD_SELECTION_SECTION_IDS.flatMap((sectionId) => {
                const value = record[sectionId];
                return isWizardPresentation(value ?? '') && value !== 'auto'
                    ? [[sectionId, value]]
                    : [];
            }),
        ) as Partial<Record<NewSessionWizardSelectionSectionId, NewSessionWizardSectionPresentation>>;
    }, [presentationBySection]);

    const handleChange = React.useCallback((
        sectionId: NewSessionWizardSelectionSectionId,
        value: NewSessionWizardSectionPresentation,
    ) => {
        void setSetting(NEW_SESSION_WIZARD_SETTINGS.settings[sectionId], value);
    }, [setSetting]);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <SettingsPageHeader description={t('settingsSessionPages.wizard.pageDescription')} />
            <ItemGroup
                title={t('settingsSessionPages.wizard.wideScreensSection')}
                description={t('settingsSession.sessionCreation.wizardLayoutFooter')}
            >
                <SettingRow
                    setting={NEW_SESSION_WIZARD_SETTINGS.settings.columns}
                    testID="settings-new-session-wizard-columns"
                    subtitle={t(
                        columnsEnabled === true
                            ? 'settingsSession.sessionCreation.wizardColumnsEnabledSubtitle'
                            : 'settingsSession.sessionCreation.wizardColumnsDisabledSubtitle',
                    )}
                    rightElement={(
                        <Switch
                            value={columnsEnabled === true}
                            onValueChange={(next) => setColumnsEnabled(Boolean(next))}
                        />
                    )}
                    showChevron={false}
                    onPress={() => setColumnsEnabled(columnsEnabled !== true)}
                />
            </ItemGroup>
            <ItemGroup
                title={t('settingsSessionPages.wizard.stepsSection')}
                description={t('settingsSession.sessionCreation.wizardPresentationFooter')}
            >
                {STEP_IDS.map((stepId) => (
                    <WizardStepPresentationRow
                        key={stepId}
                        stepId={stepId}
                        value={normalizedPresentationBySection[stepId] ?? 'auto'}
                        onChange={handleChange}
                    />
                ))}
            </ItemGroup>
        </ItemList>
    );
});

export default NewSessionWizardSettingsView;
