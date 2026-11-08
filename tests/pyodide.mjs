// Exercise the same staged Python sources and WASM runtime shipped to Live.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const runtime = path.resolve("dist/pyodide");
const { loadPyodide } = await import(pathToFileURL(path.join(runtime, "pyodide.mjs")));
const py = await loadPyodide({ indexURL: runtime });
await py.loadPackage("numpy");
py.FS.mkdirTree("/lib/pytheory");
for (const file of fs.readdirSync("dist/pytheory")) {
  py.FS.writeFile(`/lib/pytheory/${file}`, fs.readFileSync(`dist/pytheory/${file}`));
}
py.runPython('import sys; sys.path.insert(0, "/lib")');
py.runPython(fs.readFileSync("src/analysis.py", "utf8"));
const required = JSON.parse(fs.readFileSync("pytheory-version.json", "utf8")).version;
assert.equal(py.runPython("__import__('pytheory').__version__"), required);
try {
  py.runPython(fs.readFileSync("tests/regression.py", "utf8"));
} catch (error) {
  console.error(String(error));
  process.exit(1);
}

// Verify both transports used by the real extension, not just direct Python.
const { Worker } = await import("node:worker_threads");
const { spawn } = await import("node:child_process");
async function smoke(mode) {
  const workerFile = path.resolve("dist/python-worker.mjs");
  const endpoint = mode === "worker"
    ? new Worker(pathToFileURL(workerFile))
    : spawn(process.execPath, [workerFile], { stdio: ["pipe", "pipe", "inherit"] });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${mode} timed out`)), 30000);
      let buffer = "";
      const handle = (message) => {
        try {
          if (message.bootError || message.error) throw new Error(message.bootError || message.error);
          if (message.ready) {
            const request = { id: 1, fn: "generate_from_symbols", payload: JSON.stringify({ symbols: "Ebm F#7 Caug F#m7b5 Cdim7" }) };
            if (mode === "worker") endpoint.postMessage(request);
            else endpoint.stdin.write(JSON.stringify(request) + "\n");
          } else if (message.id === 1) {
            const result = JSON.parse(message.result);
            assert.equal(result.notes.length, 18);
            assert.deepEqual(result.notes.slice(0, 3).map(n => n.pitch), [63, 66, 70]);
            clearTimeout(timer);
            resolve();
          }
        } catch (error) { clearTimeout(timer); reject(error); }
      };
      endpoint.once("error", (error) => { clearTimeout(timer); reject(error); });
      endpoint.once("exit", (code) => { clearTimeout(timer); reject(new Error(`${mode} exited early (${code})`)); });
      if (mode === "worker") endpoint.on("message", handle);
      else endpoint.stdout.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.trim()) handle(JSON.parse(line));
        }
      });
    });
    console.log(`${mode} transport passed`);
  } finally {
    if (mode === "worker") await endpoint.terminate();
    else endpoint.kill();
  }
}
await smoke("worker");
await smoke("child");
