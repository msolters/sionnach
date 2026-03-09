import { initFilterBanks } from '../dsp/chromagram';

/**
 * Load chroma filter bank from the web app's assets URL.
 */
export async function loadChromaFB(baseUrl: string): Promise<void> {
  const res = await fetch(`${baseUrl}/assets/chroma_fb.json`);
  const data: number[][] = await res.json();

  // Flatten 2D array to Float32Array (same as app.js loadResources)
  const flat = new Float32Array(data.reduce((a, r) => a + r.length, 0));
  let offset = 0;
  for (const row of data) {
    flat.set(row, offset);
    offset += row.length;
  }

  initFilterBanks(flat);
}
