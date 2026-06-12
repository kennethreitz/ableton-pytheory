// The Python runtime. Runs outside the Extension Host's vm sandbox — the
// Pyodide runtime needs dynamic import(), which vm contexts don't provide.
//
// Two transports, decided by how we were launched:
//  - worker thread (dev host): messages over parentPort
//  - child process (Live's managed host denies worker_threads under Node's
//    permission model): newline-delimited JSON over stdin/stdout
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parentPort } from "node:worker_threads";

import analysisSource from "./analysis.py";

const distDir = path.dirname(fileURLToPath(import.meta.url));

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

let send: (message: unknown) => void;
if (parentPort) {
  const port = parentPort;
  send = (message) => port.postMessage(message);
  port.on("message", handleRequest);
} else {
  // Child-process mode: stdout carries the protocol, so reroute all
  // logging (including Python's) to stderr.
  const writeOut = process.stdout.write.bind(process.stdout);
  const log = (...args: unknown[]) =>
    process.stderr.write(args.map(String).join(" ") + "\n");
  console.log = console.info = console.warn = log;
  send = (message) => writeOut(JSON.stringify(message) + "\n");

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) handleRequest(JSON.parse(line) as Request);
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

async function bootPython(): Promise<Pyodide> {
  // Under Node's permission model (Live's managed host), the legacy
  // process.binding API is denied — but Emscripten's NODEFS only wants
  // the constants, which are all public API. Substitute them.
  try {
    (process as unknown as { binding(name: string): unknown }).binding(
      "constants",
    );
  } catch {
    const os = await import("node:os");
    const crypto = await import("node:crypto");
    (process as unknown as { binding(name: string): unknown }).binding = (
      name: string,
    ) => {
      if (name === "constants") {
        return { fs: fs.constants, os: os.constants, crypto: crypto.constants };
      }
      throw new Error(`process.binding('${name}') is unavailable`);
    };
  }

  const runtimeDir = path.join(distDir, "pyodide");
  const { loadPyodide } = await import(
    pathToFileURL(path.join(runtimeDir, "pyodide.mjs")).href
  );
  const py: Pyodide = await loadPyodide({
    indexURL: runtimeDir,
    // process.stdout has no fd in worker threads (and is the protocol
    // channel in child mode); route through console, which we control.
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

  // Define the analysis functions (detect_key, detect_chords, ...).
  py.runPython(analysisSource);
  return py;
}

const pythonPromise = bootPython();
let scipyLoaded: Promise<unknown> | null = null;

// Functions that analyze a host-side audio file.
const AUDIO_FNS = new Set(["audio_to_midi", "audio_detect", "sample_pitch"]);

async function handleRequest({ id, fn, payload }: Request) {
  try {
    const py = await pythonPromise;
    if (fn === "render_audio" || AUDIO_FNS.has(fn)) {
      // The synth engine and audio analysis need scipy; load lazily.
      scipyLoaded ??= py.loadPackage("scipy");
      await scipyLoaded;
    }
    if (AUDIO_FNS.has(fn)) {
      // Pyodide can't see the host filesystem — copy the audio file into
      // the virtual FS and rewrite the path before calling Python.
      const request = JSON.parse(payload);
      py.FS.mkdirTree("/audio");
      py.FS.writeFile("/audio/input.wav", fs.readFileSync(request.hostPath));
      payload = JSON.stringify({ ...request, path: "/audio/input.wav" });
    }
    const result = py.globals.get(fn)(payload) as string;
    send({ id, result });
  } catch (error) {
    send({ id, error: String(error) });
  }
}

const permission = (
  process as unknown as { permission?: { has(name: string): boolean } }
).permission;
console.error(
  `pytheory runtime: ${parentPort ? "worker" : "child"} mode, ` +
    `permission model ${permission ? "ON" : "off"}`,
);

function describeError(error: unknown): string {
  const e = error as NodeJS.ErrnoException & {
    permission?: string;
    resource?: string;
  };
  let message = String(error);
  if (e.permission) message += ` [permission: ${e.permission}]`;
  if (e.resource) message += ` [resource: ${e.resource}]`;
  return message;
}

// Tell the main thread we exist; it resolves readiness on first reply anyway.
pythonPromise
  .then(() => send({ ready: true }))
  .catch((error) => {
    console.error("boot failure:", (error as Error).stack ?? error);
    send({ bootError: describeError(error) });
  });
