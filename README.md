# ableton-pytheory

An [Ableton Live Extension](https://ableton.github.io/extensions-sdk) that brings
[pytheory](https://github.com/kennethreitz/pytheory) — Music Theory for Humans —
into Live.

## Features

Right-click a **MIDI clip**:

- **Detect Key** — `Key.detect()` over the clip's notes, plus the top scale
  candidates ranked by fitness.
- **Detect Chords** — clusters notes by onset, names each chord
  (`D minor 7th`), gives its lead-sheet symbol (`Dm7`) and Roman numeral
  function in the detected key (`ii`).
- **Analyze Melody** — every note's scale degree in the detected key, plus
  range, degree histogram, and how diatonic the line is.
- **Suggest Next Chord** — ranks likely continuations of the clip's last
  chord using transition statistics mined from pytheory's progression corpus.
- **Chord Substitutions** — relative/parallel swaps, tritone substitutions,
  and secondary dominants for each chord in the clip.
- **Negative Harmony** — mirrors the clip around the key's tonic–dominant
  axis (C major becomes C minor); run it twice to get back.
- **Guitar Tabs…** — fingering charts for the clip's chords plus a full
  fretboard map of the detected scale, on guitar, ukulele, bass, mandolin,
  or banjo. Works on melodic clips too.
- **Harmonize…** — adds diatonic thirds, sixths, full triads, or octaves
  above or below the melody, in the detected key.
- **Arpeggiate…** — replaces block chords with arpeggios (up, down, or
  up-and-down at 32nd–quarter rates).
- **Conform to Scale…** — snaps out-of-scale notes to the nearest scale tone
  (key prefilled from detection), as one undo step.
- **Transpose to Key…** — scale-degree-aware transposition: C major → C minor
  moves E to E♭, not everything chromatically.
- **Smooth Voicings** — re-voices each chord (inversions and octaves) to
  minimize voice-leading movement from the previous one.
- **Show Notation** — engraved sheet music for the clip, rendered in the
  dialog (via pytheory's ABC export + abcjs), plus the LilyPond source,
  saved as a `.ly` file and ready to copy.
- **Generate Bassline…** — follows the clip's chords onto a new MIDI track:
  roots, root–fifth, arpeggiated, or walking (with chromatic approach notes).
- **Render to Audio…** — renders the clip with pytheory's synth engine
  (46 instruments) onto a new audio track. No plugins involved.

Right-click an empty **clip slot**:

- **Generate Progression…** — pick a key, mode, and progression (14 built-ins
  from rock to jazz to flamenco, your own Roman numerals like `I vi ii V7`,
  chord symbols like `Am7 D7 Gmaj7`, or a random walk through the
  progression corpus) and get a MIDI clip of the chords.
- **Generate Melody…** — random in-key melodies: mostly stepwise with
  occasional leaps, breathing rests, resolving to the tonic. Pick the
  density from sparse to busy.
- **Generate Scale…** — write any of pytheory's scales as a runnable clip,
  up or up-and-down.
- **Generate Drum Pattern…** — 100 preset patterns (house, bossa nova,
  teental, drum and bass, second line…) with 37 optional fills, written to
  the General MIDI drum map.

## How it works

The real pytheory Python package runs *inside* the extension via
[Pyodide](https://pyodide.org) (CPython compiled to WebAssembly) — no system
Python required, nothing to install, fully offline. The build stages the
Pyodide runtime, a numpy wheel, and the pytheory sources into `dist/`.

Pyodide needs dynamic `import()`, which the Extension Host's vm sandbox
doesn't provide, so the interpreter runs in a worker thread and the extension
talks to it via messages.

```
src/extension.ts      commands + context menu actions
src/python.ts         worker management + request/reply bridge
src/python-worker.ts  worker thread: Pyodide bootstrap (loads pytheory)
src/analysis.py       analysis/generation functions that run inside Pyodide
src/dialogs.ts        dialogs and forms (webview HTML)
build.ts              esbuild bundles + runtime asset staging
```

## Development

Prerequisites:

- Node ≥ 24
- An Ableton Live build with Extensions support (currently the Live beta —
  sign up at [ableton.centercode.com](https://ableton.centercode.com))
- The Ableton Extensions SDK distribution zip (from the same beta portal).
  Its tarballs are **not** included in this repo (Ableton's SDK license
  doesn't permit redistribution): copy
  `ableton-extensions-sdk-<version>.tgz` and
  `ableton-extensions-cli-<version>.tgz` from the SDK zip into `vendor/`.
- The [pytheory](https://github.com/kennethreitz/pytheory) repo checked out
  as a sibling directory (or set `PYTHEORY_PATH` to its location)

Then:

1. Enable **Developer Mode** in Live: Preferences → Extensions.
2. Create `.env` with `EXTENSION_HOST_PATH=` pointing at Live's
   `ExtensionHostNodeModule.node` (inside the Live app bundle under
   `Contents/Helpers/ExtensionHost/`).
3. `npm install`
4. `npm start` — builds and launches the Extension Host against Live.

Logs (including `console.log` and uncaught exceptions) land in
`~/Library/Preferences/Ableton/Live x.x.x/ExtensionHost.txt`.

## Packaging

`npm run package` produces `pytheory-<version>.ablx` (~25 MB — Pyodide plus
numpy and scipy wheels), installable by dropping it onto Live's Settings →
Extensions page.

## License

MIT. The Ableton Extensions SDK and pytheory are licensed separately by
their respective owners.
