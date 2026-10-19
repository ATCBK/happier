import * as React from 'react';

import {
  readLocalDirectVoiceSettings,
  voiceSettingsParse,
  writeLocalDirectVoiceSettings,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import { isLocalVoiceProviderSelected, parseLocalVoiceTtsSettings } from '@/voice/local/localVoiceSettings';
import { LocalVoiceTtsGroup, VOICE_LOCAL_TTS_SETTINGS } from '@/voice/settings/panels/localTts/LocalVoiceTtsGroup';
import { LocalVoiceSttGroup, VOICE_LOCAL_STT_SETTINGS } from '@/voice/settings/panels/localStt/LocalVoiceSttGroup';
import { VoiceHearControls, VOICE_HEAR_SETTINGS } from '@/voice/settings/panels/VoiceHearControls';
import { resolveVoiceSttCapturePlan } from '@/voice/runtime/input/resolveVoiceSttCapturePlan';
import { resolveVoiceProviderIdFromSettings } from '@/voice/settings/resolveVoiceProviderId';
import type { VoiceDaemonRouteDiagnosticReason } from '@/voice/settings/voiceProviderLocalAvailability';
import { useVoiceSettingsSearchPrerequisite } from '@/voice/settings/VoiceSettingsSearchPrerequisite';
import { useVoiceContributedSettingsDeclarations } from '@/voice/settings/useVoiceContributedSettingRefs';
import { voiceSettingsDeclarationRegistry } from '@/voice/settings/voiceContributedSettingsDeclarations';
import { t } from '@/text';

export function LocalDirectSection(props: {
  voice: VoiceSettings;
  setVoice: (next: VoiceSettings) => void;
  popoverBoundaryRef?: React.RefObject<any> | null;
  daemonRouteDiagnosticReason?: VoiceDaemonRouteDiagnosticReason | null;
}) {
  const searchPrerequisite = useVoiceSettingsSearchPrerequisite();
  const voice = voiceSettingsParse(props.voice);
  const declarations = useVoiceContributedSettingsDeclarations('voiceConversations');
  const enabled = resolveVoiceProviderIdFromSettings(voice) === 'local_direct';
  if (!enabled) {
    if (isLocalVoiceProviderSelected({ voice })) return null;
    const speechProviders = voiceSettingsDeclarationRegistry.list().filter((entry) => entry.kind === 'voice.speech-engine.v1');
    const speechSettings = declarations.filter((page) => speechProviders.some((entry) => page.sections[`provider.${entry.providerId}`]))
      .flatMap((page) => Object.values(page.settings));
    return searchPrerequisite({ settings: [...VOICE_LOCAL_STT_SETTINGS, ...VOICE_LOCAL_TTS_SETTINGS, ...VOICE_HEAR_SETTINGS, ...speechSettings], reason: t('settingsVoice.pages.search.select', { choice: t('settingsVoice.mode.local'), control: t('settingsVoice.providerSectionTitle') }), group: true });
  }

  const cfg = readLocalDirectVoiceSettings(voice);

  const setCfg = (patch: Partial<typeof cfg>) => {
    props.setVoice(writeLocalDirectVoiceSettings(voice, { ...cfg, ...patch }));
  };


  return (
    <>
      <LocalVoiceSttGroup
        cfgStt={cfg.stt}
        otherSpeechProviderId={cfg.tts.provider}
        setStt={(next) => setCfg({ stt: next })}
        voice={voice}
        setVoice={props.setVoice}
        popoverBoundaryRef={props.popoverBoundaryRef}
        daemonRouteDiagnosticReason={props.daemonRouteDiagnosticReason}
      >
        <VoiceHearControls
          handsFree={cfg.handsFree}
          handsFreeSupported={resolveVoiceSttCapturePlan({ voice }).provider !== 'recorded_audio'}
          setHandsFree={(handsFree) => setCfg({ handsFree })}
          bargeInEnabled={parseLocalVoiceTtsSettings(cfg.tts).bargeInEnabled}
          setBargeInEnabled={(bargeInEnabled) => setCfg({ tts: { ...parseLocalVoiceTtsSettings(cfg.tts), bargeInEnabled } })}
          testIDPrefix="settings.voice.localDirect"
        />
      </LocalVoiceSttGroup>


      <LocalVoiceTtsGroup
        cfgTts={cfg.tts}
        otherSpeechProviderId={cfg.stt.provider}
        setTts={(next) => setCfg({ tts: next })}
        voice={voice}
        setVoice={props.setVoice}
        networkTimeoutMs={cfg.networkTimeoutMs}
        popoverBoundaryRef={props.popoverBoundaryRef}
        daemonRouteDiagnosticReason={props.daemonRouteDiagnosticReason}
      />

    </>
  );
}
