import * as path from "node:path";
import { Worker } from "node:worker_threads";

// Pyodide needs dynamic import(), which the Extension Host's vm sandbox
// doesn't support — so the Python runtime lives in a worker thread and we
// talk to it via messages.

interface WorkerReply {
  id?: number;
  result?: string;
  error?: string;
  ready?: boolean;
  bootError?: string;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<
  number,
  { resolve: (result: string) => void; reject: (error: Error) => void }
>();

/** Start the Python worker. Cached after the first call. */
export function getPython(): Worker {
  if (worker) return worker;

  worker = new Worker(path.join(__dirname, "python-worker.mjs"));
  worker.unref(); // don't keep the host process alive on shutdown

  worker.on("message", (reply: WorkerReply) => {
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
  });

  worker.on("error", (error) => {
    console.error("pytheory: Python worker crashed:", error);
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    worker = null; // allow a restart on the next call
  });

  return worker;
}

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

/** Run one of the analysis.py functions with a JSON payload. */
export async function analyze<T>(
  fn: AnalysisFunction,
  notes: unknown,
): Promise<T & { error?: string }> {
  const w = getPython();
  const id = nextId++;
  const result = await new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, fn, payload: JSON.stringify(notes) });
  });
  return JSON.parse(result);
}
