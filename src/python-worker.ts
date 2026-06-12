// Runs in a worker thread, outside the Extension Host's vm sandbox — the
// Pyodide runtime needs dynamic import(), which vm contexts don't provide.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parentPort } from "node:worker_threads";

const distDir = path.dirname(fileURLToPath(import.meta.url));

import analysisSource from "./analysis.py";

interface Pyodide {
  loadPackage(name: string): Promise<unknown>;
  runPython(code: string): unknown;
  globals: { get(name: string): (...args: unknown[]) => unknown };
  FS: {
    mkdirTree(dir: string): void;
    writeFile(file: string, data: Uint8Array): void;
  };
}

interface Request {
  id: number;
  fn: string;
  payload: string;
}

async function bootPython(): Promise<Pyodide> {
  const runtimeDir = path.join(distDir, "pyodide");
  const { loadPyodide } = await import(
    pathToFileURL(path.join(runtimeDir, "pyodide.mjs")).href
  );
  const py: Pyodide = await loadPyodide({
    indexURL: runtimeDir,
    // process.stdout has no fd in worker threads; route through console,
    // which the host forwards to the ExtensionHost log.
    stdout: (line: string) => console.log(line),
    stderr: (line: string) => console.error(line),
  });

  // pytheory imports numpy at package-import time.
  await py.loadPackage("numpy");

  // Copy the pytheory sources into Pyodide's virtual filesystem.
  const sourceDir = path.join(distDir, "pytheory");
  py.FS.mkdirTree("/lib/pytheory");
  for (const file of fs.readdirSync(sourceDir)) {
    py.FS.writeFile(
      `/lib/pytheory/${file}`,
      fs.readFileSync(path.join(sourceDir, file)),
    );
  }
  py.runPython('import sys; sys.path.insert(0, "/lib")');

  // Define the analysis functions (detect_key, detect_chords).
  py.runPython(analysisSource);
  return py;
}

const pythonPromise = bootPython();

parentPort!.on("message", async ({ id, fn, payload }: Request) => {
  try {
    const py = await pythonPromise;
    const result = py.globals.get(fn)(payload) as string;
    parentPort!.postMessage({ id, result });
  } catch (error) {
    parentPort!.postMessage({ id, error: String(error) });
  }
});

// Tell the main thread we exist; it resolves readiness on first reply anyway.
pythonPromise
  .then(() => parentPort!.postMessage({ ready: true }))
  .catch((error) => parentPort!.postMessage({ bootError: String(error) }));
