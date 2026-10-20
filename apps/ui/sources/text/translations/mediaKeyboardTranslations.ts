import type { SupportedLanguage } from '../_all';

type MediaKeyboardCopy = Readonly<Record<'mediaPrevious' | 'mediaNext' | 'mediaZoomIn' | 'mediaZoomOut' | 'mediaFit' | 'mediaActualSize' | 'mediaPlayPause', string>>;

export const mediaKeyboardTranslations = {
    en: { mediaPrevious: 'Previous media item', mediaNext: 'Next media item', mediaZoomIn: 'Zoom in', mediaZoomOut: 'Zoom out', mediaFit: 'Fit media', mediaActualSize: 'Actual size', mediaPlayPause: 'Play or pause media' },
    fr: { mediaPrevious: 'Média précédent', mediaNext: 'Média suivant', mediaZoomIn: 'Agrandir', mediaZoomOut: 'Réduire', mediaFit: 'Ajuster le média', mediaActualSize: 'Taille réelle', mediaPlayPause: 'Lire ou mettre en pause le média' },
    de: { mediaPrevious: 'Vorheriges Medium', mediaNext: 'Nächstes Medium', mediaZoomIn: 'Vergrößern', mediaZoomOut: 'Verkleinern', mediaFit: 'Medium einpassen', mediaActualSize: 'Tatsächliche Größe', mediaPlayPause: 'Medium abspielen oder pausieren' },
    es: { mediaPrevious: 'Contenido anterior', mediaNext: 'Contenido siguiente', mediaZoomIn: 'Acercar', mediaZoomOut: 'Alejar', mediaFit: 'Ajustar contenido', mediaActualSize: 'Tamaño real', mediaPlayPause: 'Reproducir o pausar contenido' },
    it: { mediaPrevious: 'Contenuto precedente', mediaNext: 'Contenuto successivo', mediaZoomIn: 'Ingrandisci', mediaZoomOut: 'Riduci', mediaFit: 'Adatta contenuto', mediaActualSize: 'Dimensioni reali', mediaPlayPause: 'Riproduci o sospendi contenuto' },
    pt: { mediaPrevious: 'Mídia anterior', mediaNext: 'Próxima mídia', mediaZoomIn: 'Ampliar', mediaZoomOut: 'Reduzir', mediaFit: 'Ajustar mídia', mediaActualSize: 'Tamanho real', mediaPlayPause: 'Reproduzir ou pausar mídia' },
    ca: { mediaPrevious: 'Contingut anterior', mediaNext: 'Contingut següent', mediaZoomIn: 'Apropa', mediaZoomOut: 'Allunya', mediaFit: 'Ajusta el contingut', mediaActualSize: 'Mida real', mediaPlayPause: 'Reprodueix o pausa el contingut' },
    pl: { mediaPrevious: 'Poprzedni plik multimedialny', mediaNext: 'Następny plik multimedialny', mediaZoomIn: 'Powiększ', mediaZoomOut: 'Pomniejsz', mediaFit: 'Dopasuj multimedia', mediaActualSize: 'Rzeczywisty rozmiar', mediaPlayPause: 'Odtwórz lub wstrzymaj multimedia' },
    ru: { mediaPrevious: 'Предыдущий медиафайл', mediaNext: 'Следующий медиафайл', mediaZoomIn: 'Увеличить', mediaZoomOut: 'Уменьшить', mediaFit: 'Вписать медиафайл', mediaActualSize: 'Исходный размер', mediaPlayPause: 'Воспроизвести или приостановить медиафайл' },
    ja: { mediaPrevious: '前のメディア', mediaNext: '次のメディア', mediaZoomIn: '拡大', mediaZoomOut: '縮小', mediaFit: '画面に合わせる', mediaActualSize: '実際のサイズ', mediaPlayPause: 'メディアの再生・一時停止' },
    'zh-Hans': { mediaPrevious: '上一个媒体项目', mediaNext: '下一个媒体项目', mediaZoomIn: '放大', mediaZoomOut: '缩小', mediaFit: '适合窗口', mediaActualSize: '实际大小', mediaPlayPause: '播放或暂停媒体' },
    'zh-Hant': { mediaPrevious: '上一個媒體項目', mediaNext: '下一個媒體項目', mediaZoomIn: '放大', mediaZoomOut: '縮小', mediaFit: '符合視窗', mediaActualSize: '實際大小', mediaPlayPause: '播放或暫停媒體' },
} as const satisfies Record<SupportedLanguage, MediaKeyboardCopy>;
