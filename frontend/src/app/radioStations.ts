export interface RadioStation {
  id: string;
  name: string;
  url: string;
}

export const radioStations: readonly RadioStation[] = [
  { id: "groove-salad", name: "SomaFM · Groove Salad", url: "https://ice1.somafm.com/groovesalad-128-mp3" },
  { id: "secret-agent", name: "SomaFM · Secret Agent", url: "https://ice1.somafm.com/secretagent-128-mp3" },
  { id: "radio-paradise", name: "Radio Paradise", url: "https://stream.radioparadise.com/mp3-128" }
];
