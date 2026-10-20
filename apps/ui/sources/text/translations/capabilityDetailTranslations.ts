// Capability detail grammar copy (P5 U5.6/U5.7): words shared by every capability detail page.
// Mounted under `capabilities.detail`.

export type CapabilityDetailTranslation = Readonly<{
  /** A segmented value that follows a default, announced after its label ("Ask, default"). */
  inheritedValue: string;
  onYourMachines: string;
  byMachine: string;
  noMachines: string;
  /** The folded tail of a long machine list ("12 more machines"). */
  moreMachines: (params: Readonly<{ count: number }>) => string;
}>;

const en: CapabilityDetailTranslation = { inheritedValue: 'default', onYourMachines: 'On your machines', byMachine: 'By machine', noMachines: 'No machines yet', moreMachines: ({ count }) => `${count} more ${count === 1 ? 'machine' : 'machines'}` };
const ca: CapabilityDetailTranslation = { inheritedValue: 'per defecte', onYourMachines: 'Als teus ordinadors', byMachine: 'Per ordinador', noMachines: 'Encara no hi ha ordinadors', moreMachines: ({ count }) => `${count} ordinadors més` };
const de: CapabilityDetailTranslation = { inheritedValue: 'Standard', onYourMachines: 'Auf deinen Rechnern', byMachine: 'Nach Rechner', noMachines: 'Noch keine Rechner', moreMachines: ({ count }) => `${count} weitere Rechner` };
const es: CapabilityDetailTranslation = { inheritedValue: 'predeterminado', onYourMachines: 'En tus equipos', byMachine: 'Por equipo', noMachines: 'Aún no hay equipos', moreMachines: ({ count }) => `${count} equipos más` };
const fr: CapabilityDetailTranslation = { inheritedValue: 'par défaut', onYourMachines: 'Sur vos machines', byMachine: 'Par machine', noMachines: 'Aucune machine pour l’instant', moreMachines: ({ count }) => `${count} autres machines` };
const it: CapabilityDetailTranslation = { inheritedValue: 'predefinito', onYourMachines: 'Sui tuoi computer', byMachine: 'Per computer', noMachines: 'Ancora nessun computer', moreMachines: ({ count }) => `Altri ${count} computer` };
const ja: CapabilityDetailTranslation = { inheritedValue: '既定', onYourMachines: 'あなたのマシン', byMachine: 'マシン別', noMachines: 'マシンはまだありません', moreMachines: ({ count }) => `ほか ${count} 台のマシン` };
const pl: CapabilityDetailTranslation = { inheritedValue: 'domyślnie', onYourMachines: 'Na twoich komputerach', byMachine: 'Według komputera', noMachines: 'Brak komputerów', moreMachines: ({ count }) => `Jeszcze ${count} komputerów` };
const pt: CapabilityDetailTranslation = { inheritedValue: 'padrão', onYourMachines: 'Nas suas máquinas', byMachine: 'Por máquina', noMachines: 'Ainda não há máquinas', moreMachines: ({ count }) => `Mais ${count} máquinas` };
const ru: CapabilityDetailTranslation = { inheritedValue: 'по умолчанию', onYourMachines: 'На ваших компьютерах', byMachine: 'По компьютерам', noMachines: 'Компьютеров пока нет', moreMachines: ({ count }) => `Ещё компьютеров: ${count}` };
const zhHans: CapabilityDetailTranslation = { inheritedValue: '默认', onYourMachines: '在你的设备上', byMachine: '按设备', noMachines: '还没有设备', moreMachines: ({ count }) => `另外 ${count} 台设备` };
const zhHant: CapabilityDetailTranslation = { inheritedValue: '預設', onYourMachines: '在你的裝置上', byMachine: '依裝置', noMachines: '尚無裝置', moreMachines: ({ count }) => `另外 ${count} 台裝置` };

export const capabilityDetailTranslations = { en, ca, de, es, fr, it, ja, pl, pt, ru, zhHans, zhHant } as const;
