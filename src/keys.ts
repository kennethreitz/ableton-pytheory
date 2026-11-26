// Pure key/scale helpers shared by the extension (and unit-tested on their own).

/** The subset of the Python options these helpers need. */
export interface ScaleOptions {
  tonics: string[];
  scales: string[];
  scaleIntervals?: Record<string, number[]>;
}

const SHARP_TONICS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
// Conventional spellings for the Set's root: flats for flat keys, sharps
// for sharp keys (C# minor, but Db major).
const MAJOR_TONICS = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MINOR_TONICS = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"];

/** Is `a` (semitone offsets) a subset of `b`? */
function isSubset(a: number[], b: number[]): boolean {
  return a.every((x) => b.includes(x));
}

/**
 * The pytheory scale that best matches Live's current scale: an exact
 * interval match first (Dorian is dorian), then the smallest pytheory scale
 * containing every Live interval (Minor Pentatonic sits inside minor), then
 * a name-based major/minor guess.
 */
export function matchScale(
  liveName: string,
  intervals: number[] | undefined,
  options: ScaleOptions,
): string {
  const lower = liveName.toLowerCase();
  if (options.scales.includes(lower)) return lower;
  const table = options.scaleIntervals ?? {};
  if (intervals && intervals.length) {
    const wanted = [...new Set(intervals.map((i) => ((i % 12) + 12) % 12))].sort((a, b) => a - b);
    // Prefer the plain names (major/minor) over their modal aliases.
    const preference = ["major", "minor", ...options.scales];
    const ordered = [...new Set(preference)].filter((name) => table[name]);
    const exact = ordered.find(
      (name) => table[name].length === wanted.length && isSubset(wanted, table[name]),
    );
    if (exact) return exact;
    const superset = ordered
      .filter((name) => isSubset(wanted, table[name]))
      .sort((a, b) => table[a].length - table[b].length)[0];
    if (superset) return superset;
  }
  // Nothing contains it (e.g. Blues has a b5): go by its third, then name.
  if (intervals?.includes(3) && !intervals.includes(4)) return "minor";
  return lower.includes("minor") ? "minor" : "major";
}

/** Spell a 0–11 root the way a musician would for this scale. */
export function spellTonic(root: number, scale: string, options: ScaleOptions): string {
  const minorish = (options.scaleIntervals?.[scale] ?? []).includes(3);
  const spelled = (minorish ? MINOR_TONICS : MAJOR_TONICS)[root];
  return options.tonics.includes(spelled) ? spelled : SHARP_TONICS[root];
}
