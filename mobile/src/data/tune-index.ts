import type { TuneEntry, TuneIndex } from '../types';

let tuneIndex: TuneIndex[] = [];
let tuneById: Map<number, TuneEntry> = new Map();
let tuneEntries: TuneEntry[] = [];

/**
 * Load tune index from the web app's assets URL.
 * The tune_index.json and label_map.json are hosted alongside the web app.
 */
export async function loadTuneData(baseUrl: string): Promise<void> {
  const [indexRes, labelRes, tunesRes] = await Promise.all([
    fetch(`${baseUrl}/assets/tune_index.json`),
    fetch(`${baseUrl}/assets/label_map.json`),
    fetch(`${baseUrl}/assets/tunes.json`),
  ]);

  const labelMap: Record<string, number> = await labelRes.json();
  const tunesData: TuneEntry[] = await tunesRes.json();

  // Build tuneIndex (label_map maps className -> classIdx)
  // label_map format: { "tuneName (type)": classIndex }
  const indexEntries: TuneIndex[] = [];
  for (const [key, idx] of Object.entries(labelMap)) {
    const match = key.match(/^(.+)\s+\((\w+)\)$/);
    const tune = tunesData.find(t => {
      if (match) return t.name === match[1] && t.type === match[2];
      return t.name === key;
    });
    indexEntries[idx] = {
      id: tune?.id ?? 0,
      name: match ? match[1] : key,
      type: match ? match[2] : '',
    };
  }
  tuneIndex = indexEntries;

  // Build tuneById lookup
  tuneById = new Map();
  for (const t of tunesData) {
    tuneById.set(t.id, t);
  }
  tuneEntries = tunesData;
}

export function getTuneIndex(): TuneIndex[] {
  return tuneIndex;
}

export function getTuneById(id: number): TuneEntry | undefined {
  return tuneById.get(id);
}

export function getAllTunes(): TuneEntry[] {
  return tuneEntries;
}
