export const fonts = {
  melodix: ['fontMelodix', 'var(--ad-font-family-melodix)'],
  melodixText: ['fontMelodixText', 'var(--ad-font-family-melodix-text)'],
  segoe: [
    'fontSegoe',
    '"Segoe UI Variable", "Segoe UI", system-ui, sans-serif',
  ],
  humanist: ['fontHumanist', '"Trebuchet MS", "Segoe UI", sans-serif'],
  serif: ['fontSerif', 'Georgia, "Times New Roman", serif'],
  mono: ['fontMono', 'var(--ad-font-family-mono)'],
} as const;
export const radioStations = [
  {
    value: 'groove-salad',
    label: 'SomaFM · Groove Salad',
    url: 'https://ice1.somafm.com/groovesalad-128-mp3',
  },
  {
    value: 'secret-agent',
    label: 'SomaFM · Secret Agent',
    url: 'https://ice1.somafm.com/secretagent-128-mp3',
  },
  {
    value: 'radio-paradise',
    label: 'Radio Paradise',
    url: 'https://stream.radioparadise.com/mp3-128',
  },
] as const;

export const initialSettings = {
  keyboardLighting: {
    show: false,
  },
  ai: {
    backend: 'Local',
    transferToLibraryPath: '',
    savingBackend: false,
    error: '',
  },
};
