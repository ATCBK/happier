import { localVoiceRuntimeController } from '@/voice/local/localVoiceRuntimeController';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { voiceConversationBindingResolver } from '@/voice/binding/VoiceConversationBindingResolver';
import { resolveVoiceOperationalSessionId } from '@/voice/binding/resolveVoiceOperationalSessionId';
import type { VoiceSessionBinding } from '@/voice/binding/voiceConversationBindingTypes';
import { getVoiceConversationRuntimeSnapshot } from '@/voice/runtime/machine/voiceConversationRuntimeStore';
import { deriveLocalVoiceSessionSnapshot } from '@/voice/runtime/machine/deriveLocalVoiceSessionSnapshot';

export type ActiveLocalVoiceAgentBinding = Readonly<{
  binding: VoiceSessionBinding | null;
  operationalSessionId: string;
  announcementSessionId: string;
  sendAutomaticUiContextUpdate: (update: string) => void;
  sendTextUpdate: (update: string) => Promise<void>;
  announceAssistantText: (text: string) => void;
}>;

export function resolveActiveLocalVoiceAgentBinding(): ActiveLocalVoiceAgentBinding | null {
  const binding = voiceConversationBindingResolver.resolveByControlSessionId({
    controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
    adapterId: 'local_conversation',
  });
  if (!binding) {
    return null;
  }

  const controlSessionId = binding.controlSessionId;
  const boundSessionId = resolveVoiceOperationalSessionId(binding, controlSessionId);

  const capture = deriveLocalVoiceSessionSnapshot('local_conversation', 'local', getVoiceConversationRuntimeSnapshot());
  // A connected, lazily initialized Voice Agent accepts explicit text just as
  // it accepts the first spoken turn. Prewarming is not an admission prerequisite.
  if (localVoiceRuntimeController.isAgentActive(controlSessionId)
    || (capture.status === 'connected' && capture.sessionId === controlSessionId)) {
    const announcementSessionId = binding?.conversationSessionId?.trim() || boundSessionId;
    return {
      binding,
      operationalSessionId: controlSessionId,
      announcementSessionId,
      sendAutomaticUiContextUpdate: (update) => localVoiceRuntimeController.appendAgentAutomaticUiContextUpdate(controlSessionId, update),
      sendTextUpdate: (update) => localVoiceRuntimeController.sendAgentTextUpdate(controlSessionId, update),
      announceAssistantText: (text) => localVoiceRuntimeController.announceAgentAssistantText(announcementSessionId, text),
    };
  }

  return null;
}
