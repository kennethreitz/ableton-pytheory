import { spawn } from "node:child_process";
import * as path from "node:path";
import { Worker } from "node:worker_threads";

// Pyodide needs dynamic import(), which the Extension Host's vm sandbox
// doesn't support — so the Python runtime lives out-of-context and we talk
// to it via messages. Preferred transport is a worker thread; Live's
// managed host runs Node's permission model without --allow-worker, so we
// fall back to a child process (newline-delimited JSON over stdio) there.

export type AnalysisFunction =
  | "detect_key"
  | "detect_chords"
  | "get_options"
  | "generate_progression"
  | "generate_scale"
  | "generate_drums"
  | "conform_to_scale"
  | "harmonize"
  | "arpeggiate"
  | "guitar_tabs"
  | "transpose_to_key"
  | "smooth_voicings"
  | "render_audio"
  | "analyze_melody"
  | "suggest_next_chord"
  | "chord_substitutions"
  | "negative_harmony"
  | "generate_melody"
  | "generate_from_symbols"
  | "generate_bassline"
  | "notation"
  | "invert_notes"
  | "retrograde_notes"
  | "generate_sketch"
  | "audio_to_midi"
  | "audio_detect"
  | "sample_pitch"
  | "scene_key";

interface WorkerReply {
  id?: number;
  result?: string;
  error?: string;
  ready?: boolean;
  bootError?: string;
}

interface Bridge {
  post(message: { id: number; fn: string; payload: string }): void;
}

let bridge: Bridge | null = null;
let nextId = 1;
const pending = new Map<
  number,
  { resolve: (result: string) => void; reject: (error: Error) => void }
>();

function onReply(reply: WorkerReply) {
  if (reply.bootError) {
    console.error("pytheory: Python runtime failed to boot:", reply.bootError);
    return;
  }
  if (reply.id === undefined) return; // readiness ping
  const entry = pending.get(reply.id);
  if (!entry) return;
  pending.delete(reply.id);
  if (reply.error !== undefined) {
    entry.reject(new Error(reply.error));
  } else {
    entry.resolve(reply.result!);
  }
}

function onCrash(error: Error) {
  console.error("pytheory: Python runtime crashed:", error);
  for (const entry of pending.values()) entry.reject(error);
  pending.clear();
  bridge = null; // allow a restart on the next call
}

function startWorker(runtimePath: string): Bridge {
  const worker = new Worker(runtimePath);
  worker.unref(); // don't keep the host process alive on shutdown
  worker.on("message", onReply);
  worker.on("error", onCrash);
  return { post: (message) => worker.postMessage(message) };
}

function startChildProcess(runtimePath: string): Bridge {
  const child = spawn(process.execPath, [runtimePath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.unref();

  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) onReply(JSON.parse(line) as WorkerReply);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) {
      if (line.trim()) console.error(`pytheory[py]: ${line}`);
    }
  });
  child.on("error", onCrash);
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      onCrash(new Error(`Python runtime exited with code ${code}`));
    }
  });
  return {
    post: (message) => child.stdin.write(JSON.stringify(message) + "\n"),
  };
}

/** Start the Python runtime. Cached after the first call. */
export function getPython(): Bridge {
  if (bridge) return bridge;
  const runtimePath = path.join(__dirname, "python-worker.mjs");
  try {
    bridge = startWorker(runtimePath);
    console.log("pytheory: Python runtime started in a worker thread.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ERR_ACCESS_DENIED") {
      throw error;
    }
    // Live's managed host denies worker_threads; use a child process.
    bridge = startChildProcess(runtimePath);
    console.log("pytheory: Python runtime started in a child process.");
  }
  return bridge;
}

/** Run one of the analysis.py functions with a JSON payload. */
export async function analyze<T>(
  fn: AnalysisFunction,
  notes: unknown,
): Promise<T & { error?: string }> {
  const channel = getPython();
  const id = nextId++;
  const result = await new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    channel.post({ id, fn, payload: JSON.stringify(notes) });
  });
  return JSON.parse(result);
}
