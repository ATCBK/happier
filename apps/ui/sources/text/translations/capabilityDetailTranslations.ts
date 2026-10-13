// Capability detail grammar copy (P5 U5.6/U5.7): words shared by every capability detail page.
// Mounted under `capabilities.detail`.

export type CapabilityDetailTranslation = Readonly<{
  /** A segmented value that follows a default, announced after its label ("Ask, default"). */
  inheritedValue: string;
  onYourMachines: string;
  byMachine: string;
  noMachines: string;
}>;

const en: CapabilityDetailTranslation = { inheritedValue: 'default', onYourMachines: 'On your machines', byMachine: 'By machine', noMachines: 'No machines yet' };
const ca: CapabilityDetailTranslation = { inheritedValue: 'per defecte', onYourMachines: 'Als teus ordinadors', byMachine: 'Per ordinador', noMachines: 'Encara no hi ha ordinadors' };
const de: CapabilityDetailTranslation = { inheritedValue: 'Standard', onYourMachines: 'Auf deinen Rechnern', byMachine: 'Nach Rechner', noMachines: 'Noch keine Rechner' };
const es: CapabilityDetailTranslation = { inheritedValue: 'predeterminado', onYourMachines: 'En tus equipos', byMachine: 'Por equipo', noMachines: 'Aún no hay equipos' };
const fr: CapabilityDetailTranslation = { inheritedValue: 'par défaut', onYourMachines: 'Sur vos machines', byMachine: 'Par machine', noMachines: 'Aucune machine pour l’instant' };
const it: CapabilityDetailTranslation = { inheritedValue: 'predefinito', onYourMachines: 'Sui tuoi computer', byMachine: 'Per computer', noMachines: 'Ancora nessun computer' };
const ja: CapabilityDetailTranslation = { inheritedValue: '既定', onYourMachines: 'あなたのマシン', byMachine: 'マシン別', noMachines: 'マシンはまだありません' };
const pl: CapabilityDetailTranslation = { inheritedValue: 'domyślnie', onYourMachines: 'Na twoich komputerach', byMachine: 'Według komputera', noMachines: 'Brak komputerów' };
const pt: CapabilityDetailTranslation = { inheritedValue: 'padrão', onYourMachines: 'Nas suas máquinas', byMachine: 'Por máquina', noMachines: 'Ainda não há máquinas' };
const ru: CapabilityDetailTranslation = { inheritedValue: 'по умолчанию', onYourMachines: 'На ваших компьютерах', byMachine: 'По компьютерам', noMachines: 'Компьютеров пока нет' };
const zhHans: CapabilityDetailTranslation = { inheritedValue: '默认', onYourMachines: '在你的设备上', byMachine: '按设备', noMachines: '还没有设备' };
const zhHant: CapabilityDetailTranslation = { inheritedValue: '預設', onYourMachines: '在你的裝置上', byMachine: '依裝置', noMachines: '尚無裝置' };

export const capabilityDetailTranslations = { en, ca, de, es, fr, it, ja, pl, pt, ru, zhHans, zhHant } as const;
