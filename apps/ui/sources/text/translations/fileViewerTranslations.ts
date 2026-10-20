// Tooling aggregate. Product locale roots import only their locale payload.
import { fileViewerTranslations as en } from './features/en';
import { fileViewerTranslations as ca } from './features/ca';
import { fileViewerTranslations as de } from './features/de';
import { fileViewerTranslations as es } from './features/es';
import { fileViewerTranslations as fr } from './features/fr';
import { fileViewerTranslations as it } from './features/it';
import { fileViewerTranslations as ja } from './features/ja';
import { fileViewerTranslations as pl } from './features/pl';
import { fileViewerTranslations as pt } from './features/pt';
import { fileViewerTranslations as ru } from './features/ru';
import { fileViewerTranslations as zh_Hans } from './features/zh-Hans';
import { fileViewerTranslations as zh_Hant } from './features/zh-Hant';

export const fileViewerTranslations = {
    ...en.fileViewerTranslations,
    ...ca.fileViewerTranslations,
    ...de.fileViewerTranslations,
    ...es.fileViewerTranslations,
    ...fr.fileViewerTranslations,
    ...it.fileViewerTranslations,
    ...ja.fileViewerTranslations,
    ...pl.fileViewerTranslations,
    ...pt.fileViewerTranslations,
    ...ru.fileViewerTranslations,
    ...zh_Hans.fileViewerTranslations,
    ...zh_Hant.fileViewerTranslations,
};
