import React from 'react';
import { View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { Text } from '@/components/ui/text/Text';
import { useFeatureDetails } from '@/hooks/server/useFeatureDetails';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useAllMachines, useProfile } from '@/sync/domains/state/storage';
import { t } from '@/text';

import {
  BugReportConsentSection,
  BugReportDiagnosticsSection,
  BugReportEnvironmentSection,
  BugReportFrequencySeveritySection,
  BugReportIssueDetailsSection,
  BugReportMoreDetailSection,
} from './BugReportComposerSections';
import { BugReportSimilarIssuesSection } from './BugReportSimilarIssuesSection';
import { DEFAULT_BUG_REPORT_CAPABILITIES, type BugReportsFeature } from './bugReportFeatureDefaults';
import { useBugReportComposerModel } from './hooks/useBugReportComposerModel';
import { Icon } from '@/components/ui/icons/Icon';

const submitRowStyle: ViewStyle = { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 12 };

export const BugReportComposerView = React.memo(function BugReportComposerView() {
  const safeArea = useSafeAreaInsets();
  const { theme } = useUnistyles();
  const machines = useAllMachines();
  const profile = useProfile();
  const serverUrlDefault = useActiveServerSnapshot().serverUrl;
  const bugReportsEnabled = useFeatureEnabled('bugReports');
  const bugReportsCapabilities = useFeatureDetails({
    featureId: 'bugReports',
    fallback: DEFAULT_BUG_REPORT_CAPABILITIES,
    select: (features) => features.capabilities.bugReports,
  });
  const bugReportsFeature = React.useMemo<BugReportsFeature>(
    () => ({ ...bugReportsCapabilities, enabled: bugReportsEnabled }),
    [bugReportsEnabled, bugReportsCapabilities],
  );

  const model = useBugReportComposerModel({
    feature: bugReportsFeature,
    machines,
    profile,
    serverUrlDefault,
    route: '/settings/report-issue',
  });

  const submitLabel = model.submitting
    ? t('bugReports.composer.submit.submitting')
    : model.existingIssueNumber
      ? t('bugReports.composer.submit.addToIssue', { number: model.existingIssueNumber })
      : t('bugReports.composer.submit.submitNew');

  return (
    <ItemList keyboardAware testID="bug-report-composer" contentContainerStyle={{ paddingBottom: safeArea.bottom + 32 }}>
      <SettingsPageHeader description={t('bugReports.composer.pageDescription')} />
      <BugReportIssueDetailsSection
        title={model.title}
        onTitleChange={model.setTitle}
        summary={model.summary}
        onSummaryChange={model.setSummary}
        fieldErrors={{
          title: model.fieldErrors.title,
          summary: model.fieldErrors.summary,
        }}
        disabled={model.submitting}
      />
      <BugReportSimilarIssuesSection
        loading={model.similarIssues.loading}
        issues={model.similarIssues.issues}
        selectedIssueNumber={model.existingIssueNumber}
        onSelectedIssueNumberChange={model.setExistingIssueNumber}
        disabled={model.submitting}
      />
      <BugReportFrequencySeveritySection
        frequency={model.frequency}
        onFrequencyChange={model.setFrequency}
        severity={model.severity}
        onSeverityChange={model.setSeverity}
      />
      <BugReportMoreDetailSection
        reporterGithubUsername={model.reporterGithubUsername}
        onReporterGithubUsernameChange={model.setReporterGithubUsername}
        currentBehavior={model.currentBehavior}
        onCurrentBehaviorChange={model.setCurrentBehavior}
        expectedBehavior={model.expectedBehavior}
        onExpectedBehaviorChange={model.setExpectedBehavior}
        reproductionStepsText={model.reproductionStepsText}
        onReproductionStepsTextChange={model.setReproductionStepsText}
        whatChangedRecently={model.whatChangedRecently}
        onWhatChangedRecentlyChange={model.setWhatChangedRecently}
        disabled={model.submitting}
      />
      <BugReportEnvironmentSection
        appVersion={model.appVersion}
        onAppVersionChange={model.setAppVersion}
        platformValue={model.platformValue}
        onPlatformValueChange={model.setPlatformValue}
        osVersion={model.osVersion}
        onOsVersionChange={model.setOsVersion}
        deviceModel={model.deviceModel}
        onDeviceModelChange={model.setDeviceModel}
        serverUrl={model.serverUrl}
        onServerUrlChange={model.setServerUrl}
        serverVersion={model.serverVersion}
        onServerVersionChange={model.setServerVersion}
        deploymentType={model.deploymentType}
        onDeploymentTypeChange={model.setDeploymentType}
        disabled={model.submitting}
      />
      <BugReportDiagnosticsSection
        includeDiagnostics={model.includeDiagnostics}
        onIncludeDiagnosticsChange={(value) => {
          model.setIncludeDiagnostics(value);
          if (value && model.diagnosticsKinds.length === 0) {
            model.setDiagnosticsKinds(bugReportsFeature.acceptedArtifactKinds);
          }
        }}
        acceptedKinds={bugReportsFeature.acceptedArtifactKinds}
        selectedKinds={model.diagnosticsKinds}
        onSelectedKindsChange={model.setDiagnosticsKinds}
        onPreviewDiagnostics={model.handlePreviewDiagnostics}
        previewDisabled={model.previewDisabled}
        pastedCliDoctorSnapshotJson={model.pastedCliDoctorSnapshotJson}
        onPastedCliDoctorSnapshotJsonChange={model.setPastedCliDoctorSnapshotJson}
      />
      <BugReportConsentSection
        acceptedPrivacyNotice={model.acceptedPrivacyNotice}
        onAcceptedPrivacyNoticeChange={model.setAcceptedPrivacyNotice}
        errorText={model.includeDiagnostics ? model.fieldErrors.privacy : undefined}
      />
      <ItemGroup surface="none">
        <SectionContentRow showDivider={false}>
          <View style={submitRowStyle}>
            <Text variant="body" style={{ flex: 1, minWidth: 0, color: model.submitHint === 'problem' ? theme.colors.state.danger.foreground : theme.colors.text.secondary }}>
              {model.submitHint === 'required'
                ? t('bugReports.composer.submit.requiredFieldsHint')
                : model.submitHint === 'problem' && model.validation.code !== 'ok'
                  ? model.validation.message
                  : null}
            </Text>
            <RoundButton
              testID="bug-report-submit"
              size="normal"
              title={submitLabel}
              leading={model.submitting ? undefined : <Icon name="paper-plane" size={16} color={theme.colors.button.primary.tint} />}
              loading={model.submitting}
              disabled={model.submitting || model.validation.code !== 'ok'}
              onPress={model.handleSubmit}
            />
          </View>
        </SectionContentRow>
      </ItemGroup>
    </ItemList>
  );
});
