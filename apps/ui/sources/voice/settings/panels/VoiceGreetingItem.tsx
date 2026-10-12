import * as React from 'react';

import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { useSettingActionWriter } from '@/components/settings/catalog/useSettingActionWriter';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { VoiceWelcomeSelection } from '@/voice/settings/welcome';
import { VOICE_CONVERSATIONS_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';

/**
 * Conversations → Greeting: the one control for the shared `voice.welcome` choice, whichever service
 * consumes it (Local voice's Think section or a realtime service's own group). Its declared Action
 * binding patches the current Account preferences and owns admission for both callers.
 */
export function VoiceGreetingItem(props: Readonly<{
  value: VoiceWelcomeSelection;
  /** Replaces the chosen option's description when the service cannot honour it as chosen. */
  explanation?: string;
}>) {
  const writeSetting = useSettingActionWriter();
  const onChange = async (next: VoiceWelcomeSelection) => {
    try {
      const result = await writeSetting(VOICE_CONVERSATIONS_SETTINGS.settings.greeting, next);
      if (!result.ok || result.result && typeof result.result === 'object' && 'ok' in result.result && result.result.ok === false) {
        Modal.alert(t('common.error'), t('common.saveError'));
      }
    } catch { Modal.alert(t('common.error'), t('common.saveError')); }
  };
  const describe = (id: VoiceWelcomeSelection, description: string) => (
    props.explanation && id === props.value ? props.explanation : description
  );
  return (
    <SegmentedChoiceItem<VoiceWelcomeSelection>
      title={t('settingsVoice.pages.conversations.greetingTitle')}
      subtitleLines={0}
      testIDPrefix="settings.voice.greeting"
      value={props.value}
      onChange={onChange}
      options={[
        { id: 'off', label: t('settingsVoice.pages.conversations.greetingOff'), description: describe('off', t('settingsVoice.pages.conversations.greetingOffDescription')) },
        { id: 'immediate', label: t('settingsVoice.pages.conversations.greetingRightAway'), description: describe('immediate', t('settingsVoice.pages.conversations.greetingRightAwayDescription')) },
        { id: 'on_first_turn', label: t('settingsVoice.pages.conversations.greetingAfterISpeak'), description: describe('on_first_turn', t('settingsVoice.pages.conversations.greetingAfterISpeakDescription')) },
      ]}
    />
  );
}
