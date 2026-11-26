# Changelog

## Unreleased

### Added

- **Voice Chords…** (MIDI clip). Re-voices the chords in a clip. Styles are
  close, open, spread, drop 2, drop 3, shell, quartal, or as written. You can
  also set the inversion, a register range, the amount of voice leading
  (none, smooth, or tight), and an optional bass note under each chord.
- **Chordify…** (MIDI clip). Harmonizes each melody note with a diatonic
  chord, either with the note as the root or with the melody kept on top.
  Sizes are triad, seventh, ninth, sus2, sus4, add9, or power chord.
- **Strum…** (MIDI clip). Rolls chords down, up, or alternating. Speed is set
  in milliseconds and holds at any tempo. Optional velocity taper.
- **Humanize…** (MIDI clip). Quantizes at partial strength, adds swing,
  timing drift, and velocity drift, and can use Live's velocity deviation.
  It's deterministic for a given seed, and note lengths are kept.
- **Generate Euclidean Rhythm…** (clip slot). Makes Bjorklund rhythms with
  rotation. Drums mode has four lanes for polymeters. Pitched mode plays in
  a key (root, triad, scale, random, or fifths). Includes presets.
- **Generate Melody Over Chords…** (MIDI clip). Writes a melody that follows
  the clip's chords onto a new track. Styles are singable, hook, or chord
  tones, at three densities, with optional rests.
- **Generate Progression…**
  - Adds a Recipe menu with ten ready-made progressions.
  - Accepts borrowed and applied numerals (`bVII`, `iv`, `V/V`, `IVmaj7`,
    `viiø7`, 9ths).
  - Adds voicing, chord size, and rhythm controls. The rhythms are sustain,
    quarters, offbeat, eighths, sixteenths, dotted, Charleston, and push.
  - Chord-symbol progressions keep their slash-chord bass notes.
- **Arpeggiate…**
  - Adds the patterns down-up, converge, diverge, pinky, thumb, random, and
    repeated chord.
  - Adds a range of 1 to 4 octaves, swing, gate, and a downbeat accent.
- **Generate Bassline…** adds three styles: offbeat, octave, and
  syncopated.
- **Detect Chords**
  - Shows each chord's function: tonic, pre-dominant, or dominant.
  - Spots applied dominants (`V7/V`).
  - Marks borrowed chords (`bVI` and `bVII`, spelled with flats) and the
    parallel key they come from.
  - Lists the scales that fit each chord.
  - Adds a "Name clip by chords" button.
- **Guitar Tabs…** shows up to three grips per chord.
- Regression tests (`tests/regression.py`, `tests/keys.test.ts`) now run as
  part of `npm test`.

### Changed

- Bundles PyTheory 0.59.0, up from 0.58.0.
- The Set's key is now read from Live's scale intervals, so modes and
  non-standard Live scales map to the closest pytheory scale. Flat keys are
  spelled the usual way (E♭ major, not D♯ major).
- Chord labels in generated clips follow the key's spelling (`Bb`, not `A#`).

### Compatibility

- Generate Progression and chord-symbol generation behave exactly as before
  unless the new voicing controls are used. The old payloads and outputs are
  unchanged, and the tests cover this.
