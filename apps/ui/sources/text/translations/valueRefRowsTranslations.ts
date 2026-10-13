// Copy of the one named-value row editor (environment variables, headers): `ValueRefRowsEditor`. Mounted under `capabilities.valueRows`.

export type ValueRefRowsTranslation = Readonly<{
  name: string;
  value: string;
  typeLabel: string;
  text: string;
  savedSecret: string;
  fromMachine: string;
  template: string;
  fromSession: string;
  chooseSecret: string;
  needsValue: string;
  more: (params: Readonly<{ name: string }>) => string;
  edit: string;
  remove: string;
  invalidEnvName: string;
  invalidHeaderName: string;
  duplicateName: string;
  invalidMachine: string;
}>;

const en: ValueRefRowsTranslation = {
  name: 'Name',
  value: 'Value',
  typeLabel: 'Value type',
  text: 'Text',
  savedSecret: 'Saved secret',
  fromMachine: 'From the machine',
  template: 'Template',
  fromSession: 'From the session',
  chooseSecret: 'Choose a saved secret',
  needsValue: 'Needs a value',
  more: ({ name }) => `More for ${name}`,
  edit: 'Edit…',
  remove: 'Remove',
  invalidEnvName: 'Use capital letters, digits and _ , starting with a letter.',
  invalidHeaderName: 'Use letters, digits and - only.',
  duplicateName: 'That name is already used.',
  invalidMachine: 'Name a variable on the machine, like ${HOME}.',
};

const ca: ValueRefRowsTranslation = {
  name: 'Nom',
  value: 'Valor',
  typeLabel: 'Tipus de valor',
  text: 'Text',
  savedSecret: 'Secret desat',
  fromMachine: 'De la màquina',
  template: 'Plantilla',
  fromSession: 'De la sessió',
  chooseSecret: 'Tria un secret desat',
  needsValue: 'Necessita un valor',
  more: ({ name }) => `Més per a ${name}`,
  edit: 'Edita…',
  remove: 'Elimina',
  invalidEnvName: 'Fes servir lletres majúscules, dígits i _, començant per una lletra.',
  invalidHeaderName: 'Fes servir només lletres, dígits i -.',
  duplicateName: 'Aquest nom ja s’està fent servir.',
  invalidMachine: 'Indica una variable de la màquina, com ${HOME}.',
};

const de: ValueRefRowsTranslation = {
  name: 'Name',
  value: 'Wert',
  typeLabel: 'Werttyp',
  text: 'Text',
  savedSecret: 'Gespeichertes Secret',
  fromMachine: 'Von der Maschine',
  template: 'Template',
  fromSession: 'Aus der Sitzung',
  chooseSecret: 'Gespeichertes Secret wählen',
  needsValue: 'Braucht einen Wert',
  more: ({ name }) => `Mehr zu ${name}`,
  edit: 'Bearbeiten…',
  remove: 'Entfernen',
  invalidEnvName: 'Verwende Großbuchstaben, Ziffern und _ und beginne mit einem Buchstaben.',
  invalidHeaderName: 'Verwende nur Buchstaben, Ziffern und -.',
  duplicateName: 'Dieser Name wird bereits verwendet.',
  invalidMachine: 'Gib eine Variable der Maschine an, etwa ${HOME}.',
};

const es: ValueRefRowsTranslation = {
  name: 'Nombre',
  value: 'Valor',
  typeLabel: 'Tipo de valor',
  text: 'Texto',
  savedSecret: 'Secreto guardado',
  fromMachine: 'De la máquina',
  template: 'Plantilla',
  fromSession: 'De la sesión',
  chooseSecret: 'Elige un secreto guardado',
  needsValue: 'Necesita un valor',
  more: ({ name }) => `Más para ${name}`,
  edit: 'Editar…',
  remove: 'Quitar',
  invalidEnvName: 'Usa letras mayúsculas, dígitos y _, empezando por una letra.',
  invalidHeaderName: 'Usa solo letras, dígitos y -.',
  duplicateName: 'Ese nombre ya está en uso.',
  invalidMachine: 'Indica una variable de la máquina, como ${HOME}.',
};

const fr: ValueRefRowsTranslation = {
  name: 'Nom',
  value: 'Valeur',
  typeLabel: 'Type de valeur',
  text: 'Texte',
  savedSecret: 'Secret enregistré',
  fromMachine: 'Depuis la machine',
  template: 'Modèle',
  fromSession: 'Depuis la session',
  chooseSecret: 'Choisissez un secret enregistré',
  needsValue: 'Valeur requise',
  more: ({ name }) => `Plus d’options pour ${name}`,
  edit: 'Modifier…',
  remove: 'Retirer',
  invalidEnvName: 'Utilisez des majuscules, des chiffres et _, en commençant par une lettre.',
  invalidHeaderName: 'Utilisez uniquement des lettres, des chiffres et -.',
  duplicateName: 'Ce nom est déjà utilisé.',
  invalidMachine: 'Indiquez une variable de la machine, comme ${HOME}.',
};

const it: ValueRefRowsTranslation = {
  name: 'Nome',
  value: 'Valore',
  typeLabel: 'Tipo di valore',
  text: 'Testo',
  savedSecret: 'Segreto salvato',
  fromMachine: 'Dalla macchina',
  template: 'Template',
  fromSession: 'Dalla sessione',
  chooseSecret: 'Scegli un segreto salvato',
  needsValue: 'Serve un valore',
  more: ({ name }) => `Altro per ${name}`,
  edit: 'Modifica…',
  remove: 'Rimuovi',
  invalidEnvName: 'Usa lettere maiuscole, cifre e _, iniziando con una lettera.',
  invalidHeaderName: 'Usa solo lettere, cifre e -.',
  duplicateName: 'Questo nome è già in uso.',
  invalidMachine: 'Indica una variabile della macchina, come ${HOME}.',
};

const ja: ValueRefRowsTranslation = {
  name: '名前',
  value: '値',
  typeLabel: '値の種類',
  text: 'テキスト',
  savedSecret: '保存済みシークレット',
  fromMachine: 'マシンから',
  template: 'テンプレート',
  fromSession: 'セッションから',
  chooseSecret: '保存済みシークレットを選択',
  needsValue: '値が必要です',
  more: ({ name }) => `${name} のその他の操作`,
  edit: '編集…',
  remove: '削除',
  invalidEnvName: '大文字、数字、_ を使い、先頭は文字にしてください。',
  invalidHeaderName: '文字、数字、- のみ使えます。',
  duplicateName: 'この名前はすでに使われています。',
  invalidMachine: 'マシン上の変数を指定してください（例: ${HOME}）。',
};

const pl: ValueRefRowsTranslation = {
  name: 'Nazwa',
  value: 'Wartość',
  typeLabel: 'Typ wartości',
  text: 'Tekst',
  savedSecret: 'Zapisany sekret',
  fromMachine: 'Z maszyny',
  template: 'Szablon',
  fromSession: 'Z sesji',
  chooseSecret: 'Wybierz zapisany sekret',
  needsValue: 'Wymaga wartości',
  more: ({ name }) => `Więcej dla ${name}`,
  edit: 'Edytuj…',
  remove: 'Usuń',
  invalidEnvName: 'Użyj wielkich liter, cyfr i _, zaczynając od litery.',
  invalidHeaderName: 'Użyj tylko liter, cyfr i -.',
  duplicateName: 'Ta nazwa jest już używana.',
  invalidMachine: 'Podaj zmienną na maszynie, np. ${HOME}.',
};

const pt: ValueRefRowsTranslation = {
  name: 'Nome',
  value: 'Valor',
  typeLabel: 'Tipo de valor',
  text: 'Texto',
  savedSecret: 'Segredo salvo',
  fromMachine: 'Da máquina',
  template: 'Template',
  fromSession: 'Da sessão',
  chooseSecret: 'Escolha um segredo salvo',
  needsValue: 'Precisa de um valor',
  more: ({ name }) => `Mais para ${name}`,
  edit: 'Editar…',
  remove: 'Remover',
  invalidEnvName: 'Use letras maiúsculas, dígitos e _, começando com uma letra.',
  invalidHeaderName: 'Use apenas letras, dígitos e -.',
  duplicateName: 'Esse nome já está em uso.',
  invalidMachine: 'Indique uma variável da máquina, como ${HOME}.',
};

const ru: ValueRefRowsTranslation = {
  name: 'Имя',
  value: 'Значение',
  typeLabel: 'Тип значения',
  text: 'Текст',
  savedSecret: 'Сохранённый секрет',
  fromMachine: 'С машины',
  template: 'Шаблон',
  fromSession: 'Из сессии',
  chooseSecret: 'Выберите сохранённый секрет',
  needsValue: 'Нужно значение',
  more: ({ name }) => `Ещё для ${name}`,
  edit: 'Изменить…',
  remove: 'Удалить',
  invalidEnvName: 'Используйте заглавные буквы, цифры и _, начиная с буквы.',
  invalidHeaderName: 'Используйте только буквы, цифры и -.',
  duplicateName: 'Это имя уже используется.',
  invalidMachine: 'Укажите переменную на машине, например ${HOME}.',
};

const zhHans: ValueRefRowsTranslation = {
  name: '名称',
  value: '值',
  typeLabel: '值类型',
  text: '文本',
  savedSecret: '已保存密钥',
  fromMachine: '来自机器',
  template: '模板',
  fromSession: '来自会话',
  chooseSecret: '选择已保存的密钥',
  needsValue: '需要一个值',
  more: ({ name }) => `${name} 的更多选项`,
  edit: '编辑…',
  remove: '移除',
  invalidEnvName: '使用大写字母、数字和 _，并以字母开头。',
  invalidHeaderName: '仅限字母、数字和 -。',
  duplicateName: '该名称已被使用。',
  invalidMachine: '填写机器上的变量名，例如 ${HOME}。',
};

const zhHant: ValueRefRowsTranslation = {
  name: '名稱',
  value: '值',
  typeLabel: '值類型',
  text: '文字',
  savedSecret: '已儲存的密鑰',
  fromMachine: '來自機器',
  template: '範本',
  fromSession: '來自工作階段',
  chooseSecret: '選擇已儲存的密鑰',
  needsValue: '需要一個值',
  more: ({ name }) => `${name} 的更多選項`,
  edit: '編輯…',
  remove: '移除',
  invalidEnvName: '使用大寫字母、數字和 _，並以字母開頭。',
  invalidHeaderName: '僅限字母、數字和 -。',
  duplicateName: '該名稱已被使用。',
  invalidMachine: '填寫機器上的變數名稱，例如 ${HOME}。',
};

export const valueRefRowsTranslations = {
  en,
  ca,
  de,
  es,
  fr,
  it,
  ja,
  pl,
  pt,
  ru,
  zhHans,
  zhHant,
} as const;
