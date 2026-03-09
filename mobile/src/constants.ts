// Audio & DSP constants (must match training pipeline)
export const SAMPLE_RATE = 22050;
export const N_FFT = 2048;
export const HOP_LENGTH = 512;
export const N_CHROMA = 12;
export const WINDOW_FRAMES = 344;
export const HOP_FRAMES = 172;
export const SOFTMAX_TEMP = 0.15;
export const MEDIAN_WIDTH = 9;
export const PEAK_THRESHOLD = 0.15;
export const HPSS_KERNEL = 31;

// Melody frequency range for Irish trad instruments
export const MELODY_FREQ_LO = 250;
export const MELODY_FREQ_HI = 3500;
export const DRONE_WINDOW = 172;

// Audio capture
export const CAPTURE_SAMPLE_RATE = 44100; // Native recording rate (expo-audio-studio supported)
export const MAX_AUDIO_SEC = 15;
export const MIN_AUDIO_SEC = 4;

// Inference
export const WEIGHT_STD = 0.35;
export const WEIGHT_FG = 0.65;

// Consensus & confidence
export const CONSENSUS_WINDOW = 4;
export const CONFIDENCE_FLOOR = 0.03;  // min top probability to show any prediction
export const NOISE_CYCLES = 3;         // consecutive noise cycles before clearing
export const SILENCE_CYCLES = 4;       // consecutive quiet cycles before clearing
export const MIN_DISPLAY_CONFIDENCE = 0.10; // min confidence to show predictions in UI

// UI
export const ANALYSIS_INTERVAL_MS = 500;
export const SESSION_URL = 'https://thesession.org/tunes';
