import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const production = process.argv.includes("--production");

const shared = {
  bundle: true,
  platform: "node",
  sourcesContent: false,
  logLevel: "info",
  minify: production,
  sourcemap: !production,
  loader: { ".py": "text" },
} satisfies esbuild.BuildOptions;

// The extension entry runs inside the Extension Host's vm sandbox (CJS).
await esbuild.build({
  ...shared,
  entryPoints: ["src/extension.ts"],
  outfile: manifest.entry,
  format: "cjs",
});

// The Python worker runs in a worker thread as ESM — Pyodide needs dynamic
// import(), which the vm sandbox doesn't provide. Shipped as .mjs so Node
// loads it as a module regardless of package.json "type".
await esbuild.build({
  ...shared,
  entryPoints: ["src/python-worker.ts"],
  outfile: "dist/python-worker.mjs",
  format: "esm",
});

// Ship the Pyodide runtime alongside the bundle. loadPyodide({ indexURL })
// reads pyodide.asm.wasm, python_stdlib.zip, etc. from this directory.
// Any wheels Pyodide has cached in node_modules/pyodide (e.g. numpy from a
// previous run) come along too, making the packaged extension work offline.
const pyodideSrc = "node_modules/pyodide";
const pyodideDest = path.join("dist", "pyodide");
fs.rmSync(pyodideDest, { recursive: true, force: true });
fs.mkdirSync(pyodideDest, { recursive: true });
for (const f of fs.readdirSync(pyodideSrc)) {
  const src = path.join(pyodideSrc, f);
  if (fs.statSync(src).isFile()) {
    fs.copyFileSync(src, path.join(pyodideDest, f));
  }
}

// Ensure the wheels pytheory needs ship with the runtime so loadPackage()
// works offline. Fetch the exact builds pinned in pyodide-lock.json once.
// numpy: imported by pytheory itself. scipy: effects in the synth engine.
const lock = JSON.parse(
  fs.readFileSync(path.join(pyodideDest, "pyodide-lock.json"), "utf8"),
);
const pyodideVersion = JSON.parse(
  fs.readFileSync(path.join(pyodideSrc, "package.json"), "utf8"),
).version;
for (const pkg of ["numpy", "scipy"]) {
  const wheel: string = lock.packages[pkg].file_name;
  const cachedWheel = path.join(pyodideSrc, wheel);
  if (!fs.existsSync(cachedWheel)) {
    const url = `https://cdn.jsdelivr.net/pyodide/v${pyodideVersion}/full/${wheel}`;
    console.log(`Downloading ${wheel}…`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to download ${url}: ${response.status}`);
    fs.writeFileSync(cachedWheel, Buffer.from(await response.arrayBuffer()));
  }
  fs.copyFileSync(cachedWheel, path.join(pyodideDest, wheel));
}

// Ship the pytheory Python sources; the extension writes them into Pyodide's
// virtual filesystem at startup.
const pytheorySrc = path.join(
  process.env.PYTHEORY_PATH ?? "../pytheory",
  "pytheory",
);
if (!fs.existsSync(pytheorySrc)) {
  throw new Error(
    `pytheory sources not found at ${pytheorySrc} — set PYTHEORY_PATH to the pytheory repo root.`,
  );
}
const pytheoryDest = path.join("dist", "pytheory");
fs.rmSync(pytheoryDest, { recursive: true, force: true });
fs.mkdirSync(pytheoryDest, { recursive: true });
for (const f of fs.readdirSync(pytheorySrc)) {
  if (f.endsWith(".py")) {
    fs.copyFileSync(path.join(pytheorySrc, f), path.join(pytheoryDest, f));
  }
}

// The notation dialog inlines abcjs into a webview page at runtime.
fs.copyFileSync(
  "node_modules/abcjs/dist/abcjs-basic-min.js",
  path.join("dist", "abcjs.js"),
);

// Local stand-ins for the host-provided storage/temp directories, passed
// to extensions-cli run by npm start (the dev host provides none by default).
fs.mkdirSync(".dev/storage", { recursive: true });
fs.mkdirSync(".dev/tmp", { recursive: true });

console.log("Copied Pyodide runtime, pytheory sources, and abcjs into dist/.");
