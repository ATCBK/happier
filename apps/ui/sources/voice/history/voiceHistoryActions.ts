import type { VoiceHistoryActionId } from '@happier-dev/protocol/actions/voiceConversationActionFamily';
import type { PublicActionInputById } from '@happier-dev/protocol/actions/actionSpecs';
import { isVoiceHistoryOperationSupersededError, VoiceHistoryOperationSupersededError, type VoiceHistoryConsumer, type VoiceHistoryExportArtifact } from './voiceHistoryConsumer';

/** Private delivery ports shared by the mounted page and the answering client's Action host. */
export type VoiceHistoryActionPorts = Readonly<{
  consumer: VoiceHistoryConsumer;
  saveExportArtifact: (artifact: VoiceHistoryExportArtifact) => Promise<void>;
}>;

type VoiceHistoryActionRequest = { [Id in VoiceHistoryActionId]: Readonly<{ actionId: Id; input: PublicActionInputById[Id] }> }[VoiceHistoryActionId];

/** Input has already passed the Protocol executor's exact Action schema. */
export async function executeVoiceHistoryAction(request: VoiceHistoryActionRequest,
  ports: VoiceHistoryActionPorts, isCurrent: () => boolean) {
  const assertCurrent = () => { if (!isCurrent()) throw new VoiceHistoryOperationSupersededError(); };
  try {
    assertCurrent();
    switch (request.actionId) {
      case 'ui.voice_global.history.search': {
        const value = request.input;
        const result = await ports.consumer.search(value.query, value.refresh);
        assertCurrent();
        return result;
      }
      case 'ui.voice_global.history.load_older': {
        const value = request.input;
        await ports.consumer.search();
        assertCurrent();
        const result = await ports.consumer.loadOlder(value.query);
        assertCurrent();
        return result;
      }
      case 'ui.voice_global.history.export': {
        const value = request.input;
        await ports.consumer.search();
        assertCurrent();
        const artifact = await ports.consumer.exportHistory(value);
        assertCurrent();
        await ports.saveExportArtifact(artifact);
        assertCurrent();
        return { fileName: artifact.fileName, mimeType: artifact.mimeType, rowCount: artifact.rowCount, range: artifact.range };
      }
      case 'ui.voice_global.history.clear': {
        const result = await ports.consumer.clear();
        assertCurrent();
        return result;
      }
    }
  } catch (error) {
    // Preserve the consumer's typed retirement reason across the Action result
    // boundary so every caller can present the existing Account recovery state.
    if (isVoiceHistoryOperationSupersededError(error)) return {
      ok: false as const,
      errorCode: 'voice_history_operation_superseded',
      error: 'voice_history_operation_superseded',
    };
    throw error;
  }
}
