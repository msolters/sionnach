/**
 * Format a key string from the tune index (e.g. "Edorian") into
 * human-readable format (e.g. "E Dorian").
 */
const MODES = [
  'mixolydian', 'dorian', 'phrygian', 'lydian', 'locrian',
  'aeolian', 'ionian', 'major', 'minor',
];

export function formatKey(raw: string): string {
  if (!raw) return '';

  const lower = raw.toLowerCase();
  for (const mode of MODES) {
    if (lower.endsWith(mode)) {
      const root = raw.slice(0, raw.length - mode.length);
      const capitalized = mode.charAt(0).toUpperCase() + mode.slice(1);
      return `${root} ${capitalized}`;
    }
  }

  // Fallback: return as-is
  return raw;
}
