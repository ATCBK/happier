import * as React from 'react';
import { View, type TextInput } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { useUnistyles } from 'react-native-unistyles';

import { FindBar } from '@/components/ui/find/FindBar';
import {
  FindBarPlacement,
  useFindBarPresence,
} from '@/components/ui/find/FindBarPlacement';
import { WEBVIEW_INJECTED_MESSAGE_MAX_BYTES } from '@/components/ui/webview/bridge/useWebViewBridgeMessenger';
import { t } from '@/text';

import { useFilePreviewSource } from '../useFilePreviewSource';
import { createPdfBridgeFindModel } from './pdfBridgeFindModel';
import {
  PDF_WEBVIEW_CSP,
  parsePdfWebViewMessage,
  shouldAllowPdfWebViewNavigation,
} from './pdfNativeBridge';
import { PDFJS_WEBVIEW_BUNDLE_JS } from './pdfjsWebViewBundle.generated';
import { buildPdfPageCss } from './pdfPageCss';
import { usePdfFind } from './usePdfFind';
import { transferNativePdfCacheFile } from './transferNativePdfCacheFile.native';
import {
  PdfPagePill,
  PdfViewerFailureState,
  PdfViewerFrame,
  PdfViewerLoadingState,
  type PdfPageInfo,
  type PdfViewerFailure,
  type PdfViewerProps,
} from './PdfViewerStates';

/**
 * Raw bytes per injected slice: base64 grows 4/3, so one slice fills one injected WebView message
 * (`WEBVIEW_INJECTED_MESSAGE_MAX_BYTES`, the existing tuning of this channel). Device throughput for
 * this value is a P2 §8.4 release check.
 */
const PDF_SLICE_BYTES = Math.floor(
  (WEBVIEW_INJECTED_MESSAGE_MAX_BYTES * 3) / 4,
);

type BodyState =
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'ready' }>
  | Readonly<{
      status: 'error';
      failure: PdfViewerFailure;
      code: string | null;
    }>;

/**
 * The native PDF body: pdf.js legacy in a navigation-locked WebView, bytes moved in raw slices from
 * the preview cache file (RU-12), metadata back through the strict parser. Same states and chrome as web.
 */
export function PdfViewer(props: PdfViewerProps) {
  const { theme } = useUnistyles();
  const [attempt, retry] = React.useReducer((value: number) => value + 1, 0);
  const preview = useFilePreviewSource({
    ...props.source,
    enabled: props.source.enabled && props.isActive,
  });
  const webView = React.useRef<WebView>(null);
  const inject = React.useCallback(
    (script: string) => webView.current?.injectJavaScript(script),
    [],
  );
  const [findModel] = React.useState(() => createPdfBridgeFindModel(inject));
  const [state, setState] = React.useState<BodyState>({ status: 'loading' });
  const [pageInfo, setPageInfo] = React.useState<PdfPageInfo | null>(null);
  const [pillTick, setPillTick] = React.useState(0);
  const [loaded, setLoaded] = React.useState(false);
  const latest = React.useRef(props);
  latest.current = props;

  const html = React.useMemo(() => {
    const css = buildPdfPageCss(
      '#pdf-pages',
      {
        well: theme.colors.surface.inset,
        paper: theme.colors.overlay.mediaPaper,
        hairline: theme.colors.border.default,
        matchAll: theme.colors.find.matchAll,
        matchCurrent: theme.colors.find.matchCurrent,
      },
      { gap: theme.space.s16 },
    );
    return (
      `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PDF_WEBVIEW_CSP}">` +
      '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">' +
      `<style>html,body{margin:0;height:100%;background:${theme.colors.surface.inset}}#pdf-pages{position:absolute;inset:0}${css}</style>` +
      '</head><body><div id="pdf-pages"></div></body></html>'
    );
  }, [
    theme.colors.border.default,
    theme.colors.find.matchAll,
    theme.colors.find.matchCurrent,
    theme.colors.overlay.mediaPaper,
    theme.colors.surface.inset,
    theme.space.s16,
  ]);

  // Move the bytes once the page has loaded and the preview owns its cache file.
  React.useEffect(() => {
    if (!loaded || preview.status !== 'loaded') return;
    const controller = new AbortController();
    setState({ status: 'loading' });
    inject(
      `window.__pdfRestore(${JSON.stringify(latest.current.position ?? null)});window.__pdfZoom(${JSON.stringify(latest.current.zoom)});true;`,
    );
    void transferNativePdfCacheFile({
      uri: preview.uri,
      sliceBytes: PDF_SLICE_BYTES,
      signal: controller.signal,
      injectJavaScript: inject,
    }).catch((error: unknown) => {
      if (!controller.signal.aborted)
        setState({
          status: 'error',
          failure: 'failed',
          code: error instanceof Error ? error.message : 'pdf_transfer_failed',
        });
    });
    return () => {
      controller.abort();
      inject('window.__pdfDispose();true;');
    };
  }, [attempt, inject, loaded, preview.status, preview.uri]);

  React.useEffect(() => {
    if (state.status === 'ready')
      inject(`window.__pdfZoom(${JSON.stringify(props.zoom)});true;`);
  }, [inject, props.zoom, state.status]);

  const onMessage = React.useCallback(
    (event: WebViewMessageEvent) => {
      const message = parsePdfWebViewMessage(event.nativeEvent.data);
      if (!message) return;
      findModel.acceptMessage(message);
      if (message.type === 'ready') {
        setState({ status: 'ready' });
        setPageInfo({ page: 1, total: message.pages });
      } else if (message.type === 'page') {
        setPageInfo((current) =>
          current ? { ...current, page: message.page } : current,
        );
        setPillTick((value) => value + 1);
      } else if (message.type === 'location') {
        latest.current.onPositionChange?.({
          page: message.page,
          top: message.top,
          left: message.left,
        });
      } else if (message.type === 'state' && message.state !== 'loading') {
        setState({
          status: 'error',
          failure: message.state === 'protected' ? 'protected' : 'failed',
          code: message.state === 'error' ? 'pdf_render_failed' : null,
        });
      }
    },
    [findModel],
  );

  const { onPageInfo } = props;
  React.useEffect(() => {
    if (pageInfo) onPageInfo?.(pageInfo);
  }, [onPageInfo, pageInfo]);

  const input = React.useRef<TextInput | null>(null);
  const [inputFocused, setInputFocused] = React.useState(false);
  const find = usePdfFind({
    surfaceId: props.findSurfaceId,
    document: null,
    controller: findModel,
    active: props.isActive && state.status === 'ready',
    containsFocus: () => true,
    isInputFocused: () => inputFocused,
    reveal: () => {},
    focusInput: () => input.current?.focus(),
  });
  const shown = find.snapshot.open && props.isActive;
  const presence = useFindBarPresence(shown);
  const failed =
    state.status === 'error'
      ? state
      : preview.status === 'error'
        ? { failure: 'failed' as const, code: preview.error }
        : null;

  return (
    <PdfViewerFrame testID={props.testID} presentation={props.presentation}>
      {failed ? (
        <PdfViewerFailureState
          failure={failed.failure}
          title={props.title}
          diagnosticCode={failed.code}
          onRetry={retry}
          onOpenInDefaultApp={props.onOpenInDefaultApp}
        />
      ) : (
        <View style={{ flex: 1 }}>
          <WebView
            key={attempt}
            ref={webView}
            source={{ html }}
            style={{ flex: 1, backgroundColor: theme.colors.surface.inset }}
            originWhitelist={['about:blank']}
            onShouldStartLoadWithRequest={(request) =>
              shouldAllowPdfWebViewNavigation(request.url)
            }
            injectedJavaScriptBeforeContentLoaded={PDFJS_WEBVIEW_BUNDLE_JS}
            injectedJavaScriptForMainFrameOnly
            javaScriptCanOpenWindowsAutomatically={false}
            setSupportMultipleWindows={false}
            mixedContentMode="never"
            allowFileAccess={false}
            allowUniversalAccessFromFileURLs={false}
            cacheEnabled={false}
            incognito
            domStorageEnabled={false}
            sharedCookiesEnabled={false}
            thirdPartyCookiesEnabled={false}
            accessibilityLabel={props.title}
            onLoadEnd={() => setLoaded(true)}
            onMessage={onMessage}
          />
          {state.status === 'loading' ? (
            <View
              style={{
                position: 'absolute',
                top: 0,
                right: 0,
                bottom: 0,
                left: 0,
                justifyContent: 'center',
                backgroundColor: theme.colors.surface.inset,
              }}
              pointerEvents="none"
            >
              <PdfViewerLoadingState />
            </View>
          ) : null}
        </View>
      )}
      {props.showPagePill !== false && state.status === 'ready' ? (
        <PdfPagePill info={pageInfo} zoomPercent={null} tick={pillTick} />
      ) : null}
      {presence.present ? (
        <FindBarPlacement visible={shown}>
          {(presentation) => (
            <FindBar
              query={find.snapshot.query}
              options={find.snapshot.options}
              status={find.snapshot.status}
              capabilities={find.controller.capabilities}
              surfaceLabel={t('find.surface.file')}
              presentation={presentation}
              autoFocus
              inputRef={input}
              onInputFocus={() => setInputFocused(true)}
              onInputBlur={() => setInputFocused(false)}
              onQueryChange={find.controller.setQuery}
              onOptionsChange={find.controller.setOptions}
              onStep={find.controller.step}
              onStop={find.controller.stop}
              onClose={find.controller.close}
              testID="pdf-viewer-find"
            />
          )}
        </FindBarPlacement>
      ) : null}
    </PdfViewerFrame>
  );
}
