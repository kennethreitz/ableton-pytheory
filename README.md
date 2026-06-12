# ableton-pytheory

An [Ableton Live Extension](https://ableton.github.io/extensions-sdk) that brings
[pytheory](https://github.com/kennethreitz/pytheory) — Music Theory for Humans —
into Live.

Right-click any MIDI clip:

- **Detect Key** — `pytheory.Key.detect()` over the clip's notes, plus the top
  scale candidates ranked by fitness (`Scale.recommend()`).
- **Detect Chords** — clusters notes by onset and names each chord with
  `Chord.identify()` (e.g. `D minor 7th`, `G dominant 7th`, `C major 7th`).

## How it works

The real pytheory Python package runs *inside* the extension via
[Pyodide](https://pyodide.org) (CPython compiled to WebAssembly) — no system
Python required, nothing to install, fully offline. The build copies the
Pyodide runtime, a numpy wheel, and the pytheory sources into `dist/`, and the
extension boots the interpreter lazily in the Extension Host's Node process.

Pyodide needs dynamic `import()`, which the Extension Host's vm sandbox
doesn't provide, so the interpreter runs in a worker thread and the extension
talks to it via messages.

```
src/extension.ts      commands + context menu actions
src/python.ts         worker management + request/reply bridge
src/python-worker.ts  worker thread: Pyodide bootstrap (loads pytheory)
src/analysis.py       detection functions that run inside Pyodide
src/dialogs.ts        result dialogs (webview HTML)
build.ts              esbuild bundles + runtime asset staging
```

## Development

Prerequisites: Node ≥ 24, the Live beta with Extensions support, and the
pytheory repo checked out as a sibling directory (or set `PYTHEORY_PATH`).

1. Enable **Developer Mode** in Live: Preferences → Extensions.
2. `npm install`
3. `npm start` — builds and launches the Extension Host against the Live
   path in `.env`.

Logs (including `console.log` and uncaught exceptions) land in
`~/Library/Preferences/Ableton/Live x.x.x/ExtensionHost.txt`.

## Packaging

`npm run package` produces `pytheory-<version>.ablx` (~9 MB), installable by
dropping it onto Live's Settings → Extensions page.
