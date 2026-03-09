export interface TuneSetting {
  id: number;
  abc: string;
}

export interface TuneEntry {
  id: number;
  name: string;
  type: string;
  key: string;
  settings: TuneSetting[];
}

export interface STFTResult {
  mag: Float32Array;
  nFrames: number;
  nBins: number;
}

export interface DSPResult {
  chroma: Float32Array;
  rawEnergy: Float32Array;
  nFrames: number;
  tensorsStd: Float32Array[];
  tensorsFg: Float32Array[];
  tempo: number | null;
}

export interface Prediction {
  rank: number;
  prob: number;
  id: number;
  name: string;
  type: string;
}

export interface TuneIndex {
  id: number;
  name: string;
  type: string;
}
