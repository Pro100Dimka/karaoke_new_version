// Audio settings section texts, split out of messages.en.ts, which sits at the file-size ceiling.
export const audioEn = {
  audioDevicesTitle: "Audio devices and parameters",
  audioDevicesHint: "Tune the audio system for stable, low latency",
  audioMonitorTitle: "Monitoring and signal level",
  audioMonitorHint: "Watch latency, level and the incoming signal",
  estimatedLatencyTitle: "Estimated latency",
  audioLevels: "Levels",
  microphoneKnob: "Microphone",
  inputMonitoring: "Input monitoring",
  inputMonitoringHint: "Hear the incoming signal in real time",
  acousticLatency: "Hidden latency",
  acousticLatencyUnmeasured: "not measured",
  acousticLatencyMeasure: "Measure",
  acousticLatencyMeasuring: "Measuring…",
  acousticLatencyHint:
    "Hold a headphone or speaker to the microphone: three quiet beeps will play. The result keeps room singing in sync",
  acousticLatencyMeasured: "Hidden latency: {value} ms",
  acousticLatencyUncertaintyHint:
    "An estimate relative to audio system timestamps, not a diagnosis of the cause. Measure again after changing the audio path.",
  acousticLatencyFailed: "Could not measure the latency",
  asioSetupTitle: "No ASIO driver found",
  asioDriverOpenFailed: "Could not open the selected ASIO driver.",
  asioSetupConfigureTitle: "Configure ASIO4ALL",
  asioSetupBody:
    "The app could not open an audio-interface driver. For a built-in sound card, you can install ASIO4ALL, a universal ASIO driver for Windows.",
  asioSetupInstall: "Download and install ASIO4ALL",
  asioSetupDownloading: "Downloading and verifying installer…",
  asioSetupLaunched:
    "Complete setup in the installer window. The app will detect the driver automatically.",
  asioSetupCheck: "Check installation",
  asioSetupReady:
    "ASIO4ALL was found and selected. Restart the app, then measure latency again.",
  asioSetupRestart: "Restart app",
  asioSetupConfigureBody:
    "Enable the microphone and headphones you use inside ASIO4ALL. The change is applied automatically; then use the test-sound button to verify output.",
  asioSetupConfigure: "Configure devices",
  releaseAsioInBackground: "Release ASIO in background",
  releaseAsioInBackgroundHint:
    "When the app is inactive, ASIO is temporarily stopped so other apps can use the audio device.",
  asioSetupFailed: "Could not start setup: {reason}",
} as const;
