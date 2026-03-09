import type { TuneEntry, TuneIndex } from '../types';

let tuneIndex: TuneIndex[] = [];
let tuneById: Map<number, TuneEntry> = new Map();
let tuneEntries: TuneEntry[] = [];

/**
 * Load tune index from the web app's tune_index.json.
 * Format: { "0": { id, name, type, key, settings }, "1": { ... }, ... }
 * Keys are class indices matching the model's output classes.
 */
export async function loadTuneData(baseUrl: string): Promise<void> {
  const res = await fetch(`${baseUrl}/assets/tune_index.json`);
  const data: Record<string, TuneEntry> = await res.json();

  // Build tuneIndex array indexed by class index
  const indexEntries: TuneIndex[] = [];
  for (const [key, entry] of Object.entries(data)) {
    const idx = parseInt(key, 10);
    indexEntries[idx] = {
      id: entry.id,
      name: entry.name,
      type: entry.type,
    };
  }
  tuneIndex = indexEntries;

  // Build tuneById lookup
  tuneById = new Map();
  for (const entry of Object.values(data)) {
    tuneById.set(entry.id, entry);
  }
  tuneEntries = Object.values(data);
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
