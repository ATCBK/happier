import * as React from 'react';

import { Modal } from '@/modal';
import { t } from '@/text';
import { prepareKokoroTts } from '@/voice/kokoro/runtime/synthesizeKokoroWav';
import { checkModelPackUpdateAvailable, ensureModelPackInstalled, getModelPackInstallSummary, removeModelPack } from '@/voice/modelPacks/installer.native';
import { formatModelPackBuildLabel } from '@/voice/modelPacks/formatBuildLabel';
import { fireAndForget } from '@/utils/system/fireAndForget';
import {
  confirmDiscardPartialDownload,
  readPartialDownloadBytes,
  type ModelPackRowStatus,
} from '@/voice/settings/panels/modelPack/modelPackTransferRows';

type ModelStatus = ModelPackRowStatus;

export function useLocalNeuralModelPackState(params: {
  packId: string;
  manifestUrl: string | null;
  networkTimeoutMs: number;
}): Readonly<{
  modelStatus: ModelStatus;
  downloadProgress: unknown | null;
  installed: boolean;
  installSummary: Awaited<ReturnType<typeof getModelPackInstallSummary>> | null;
  updateCheckedRemote: null | { build: string | null; updateAvailable: boolean };
  refreshInstallState: () => Promise<void>;
  prepareModel: () => Promise<void>;
  cancelPrepare: () => void;
  clearAssets: () => void;
  checkForUpdates: () => void;
}> {
  const [modelStatus, setModelStatus] = React.useState<ModelStatus>('idle');
  const [downloadProgress, setDownloadProgress] = React.useState<unknown | null>(null);
  const prepareAbortRef = React.useRef<AbortController | null>(null);
  const [installed, setInstalled] = React.useState<boolean>(false);
  const [installSummary, setInstallSummary] = React.useState<null | Awaited<ReturnType<typeof getModelPackInstallSummary>>>(null);
  const [updateCheckedRemote, setUpdateCheckedRemote] = React.useState<null | { build: string | null; updateAvailable: boolean }>(null);

  const refreshInstallState = React.useCallback(async () => {
    try {
      const summary = await getModelPackInstallSummary({ packId: params.packId });
      setInstallSummary(summary);
      setInstalled(summary.installed);
      setModelStatus((cur) => (cur === 'downloading' ? cur : summary.installed ? 'ready' : 'idle'));
      setUpdateCheckedRemote(null);
    } catch {
      setInstallSummary(null);
      setInstalled(false);
      setModelStatus((cur) => (cur === 'downloading' ? cur : 'idle'));
      setUpdateCheckedRemote(null);
    }
  }, [params.packId]);

  React.useEffect(() => {
    void refreshInstallState();
  }, [refreshInstallState]);

  const prepareModel = React.useCallback(async () => {
    if (modelStatus === 'downloading') return;

    try {
      setModelStatus('downloading');
      setDownloadProgress(null);
      const abortController = new AbortController();
      prepareAbortRef.current = abortController;

      await prepareKokoroTts({
        assetSetId: params.packId,
        timeoutMs: Math.max(60000, params.networkTimeoutMs),
        signal: abortController.signal,
        onProgress: (progress) => {
          setDownloadProgress(progress);
        },
      });

      setModelStatus('ready');
      await refreshInstallState();
    } catch (error) {
      if (prepareAbortRef.current?.signal?.aborted) {
        // A cancelled download keeps verified files; report what is on disk so it can be retried.
        setModelStatus('idle');
        await refreshInstallState();
        return;
      }
      // Verified files stay on disk after a failure; read them so the screen can offer resume or discard.
      await refreshInstallState();
      setModelStatus('error');
      await Modal.alert(t('common.error'), error instanceof Error ? error.message : String(error));
    } finally {
      prepareAbortRef.current = null;
    }
  }, [modelStatus, params.networkTimeoutMs, params.packId, refreshInstallState]);

  const cancelPrepare = React.useCallback(() => {
    const controller = prepareAbortRef.current;
    if (!controller) return;
    try {
      controller.abort();
    } catch {
      // ignore
    }
  }, []);

  const clearAssets = React.useCallback(() => {
    fireAndForget((async () => {
      if (modelStatus === 'downloading') return;
      const partialBytes = readPartialDownloadBytes(installSummary);
      const confirmed = partialBytes > 0
        ? await confirmDiscardPartialDownload(partialBytes)
        : await Modal.confirm(
          t('settingsVoice.local.kokoro.removeAssets.confirmTitle'),
          t('settingsVoice.local.kokoro.removeAssets.confirmBody'),
          { confirmText: t('settingsVoice.local.kokoro.removeAssets.confirmButton') },
        );
      if (!confirmed) return;
      await removeModelPack({ packId: params.packId });
      setModelStatus('idle');
      setDownloadProgress(null);
      await refreshInstallState();
    })(), { tag: 'useLocalNeuralModelPackState.confirm.clearAssets' });
  }, [installSummary, modelStatus, params.packId, refreshInstallState]);

  const checkForUpdates = React.useCallback(() => {
    fireAndForget((async () => {
      if (modelStatus === 'downloading') return;
      if (!params.manifestUrl) {
        await Modal.alert(
          t('settingsVoice.local.kokoro.alerts.missingManifest.title'),
          t('settingsVoice.local.kokoro.alerts.missingManifest.body'),
        );
        return;
      }

      const abortController = new AbortController();
      try {
        const status = await checkModelPackUpdateAvailable({
          packId: params.packId,
          manifestUrl: params.manifestUrl,
          timeoutMs: Math.max(30_000, params.networkTimeoutMs),
          signal: abortController.signal,
        });

        if (!status.installed) {
          await Modal.alert(
            t('settingsVoice.local.kokoro.alerts.notInstalledTitle'),
            t('settingsVoice.local.kokoro.alerts.notInstalledBody'),
          );
          return;
        }
        const remoteBuild = formatModelPackBuildLabel(status.remoteManifest);
        setUpdateCheckedRemote({ build: remoteBuild, updateAvailable: status.updateAvailable });
        if (!status.updateAvailable) {
          await Modal.alert(
            t('settingsVoice.local.kokoro.alerts.upToDateTitle'),
            t('settingsVoice.local.kokoro.alerts.upToDateBody'),
          );
          return;
        }

        const ok = await Modal.confirm(
          t('settingsVoice.local.kokoro.alerts.updateAvailableTitle'),
          t('settingsVoice.local.kokoro.alerts.updateAvailableBody', { remoteBuild }),
          {
            confirmText: t('common.update'),
          },
        );
        if (!ok) return;

        setModelStatus('downloading');
        setDownloadProgress(null);
        prepareAbortRef.current = abortController;

        await ensureModelPackInstalled({
          packId: params.packId,
          mode: 'download_if_missing',
          updatePolicy: 'manual_update_if_available',
          manifestUrl: params.manifestUrl,
          timeoutMs: Math.max(120_000, params.networkTimeoutMs),
          signal: abortController.signal,
          onProgress: (p) => {
            setDownloadProgress(p);
          },
        });

        setModelStatus('ready');
        await refreshInstallState();
        await Modal.alert(
          t('settingsVoice.local.kokoro.alerts.updatedTitle'),
          t('settingsVoice.local.kokoro.alerts.updatedBody'),
        );
      } catch (error) {
        if (!abortController.signal.aborted) {
          await Modal.alert(
            t('settingsVoice.local.kokoro.alerts.updateFailedTitle'),
            t('settingsVoice.local.kokoro.alerts.updateFailedBody', { message: String((error as any)?.message ?? error) }),
          );
        }
        // A failed or cancelled update leaves the installed pack in place; report what is on disk.
        setModelStatus('idle');
        await refreshInstallState();
      } finally {
        prepareAbortRef.current = null;
        setDownloadProgress(null);
      }
    })(), { tag: 'useLocalNeuralModelPackState.checkForUpdates' });
  }, [modelStatus, params.manifestUrl, params.networkTimeoutMs, params.packId, refreshInstallState]);

  return {
    modelStatus,
    downloadProgress,
    installed,
    installSummary,
    updateCheckedRemote,
    refreshInstallState,
    prepareModel,
    cancelPrepare,
    clearAssets,
    checkForUpdates,
  };
}
