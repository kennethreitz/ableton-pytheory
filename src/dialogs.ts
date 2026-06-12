export interface KeyResult {
  key: string | null;
  tonic: string | null;
  mode: string | null;
  noteNames: string[];
  noteCount: number;
  recommendations: { tonic: string; scale: string; fitness: number }[];
}

export interface ChordsResult {
  key: string | null;
  chords: {
    start: number;
    notes: string[];
    name: string | null;
    symbol: string | null;
    numeral: string | null;
  }[];
}

export interface Options {
  tonics: string[];
  scales: string[];
  progressions: Record<string, string[]>;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STYLE = `
  :root {
    --bg: #383838; --panel: #4E4E4E; --accent: #FFA500;
    --text: #FFFFFF; --dim: #B0B0B0; --border: #2C2C2C;
    --input-bg: #2C2C2C;
  }
  body {
    background: var(--bg); color: var(--text);
    font-family: sans-serif; font-size: 13px;
    margin: 0; padding: 16px 20px;
    display: flex; flex-direction: column; height: calc(100vh - 32px);
  }
  h1 { font-size: 15px; margin: 0 0 4px; }
  .subtitle { color: var(--dim); margin: 0 0 12px; }
  .result {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 4px; padding: 12px; flex: 1; overflow-y: auto;
  }
  .big { font-size: 22px; color: var(--accent); margin: 0 0 8px; }
  table { border-collapse: collapse; width: 100%; }
  td, th { text-align: left; padding: 3px 12px 3px 0; }
  th { color: var(--dim); font-weight: normal; }
  .dim { color: var(--dim); }
  .field { display: flex; align-items: center; margin-bottom: 10px; }
  .field label { width: 130px; color: var(--dim); }
  select, input[type="text"] {
    background: var(--input-bg); color: var(--text);
    border: 1px solid var(--border); border-radius: 3px;
    padding: 5px 8px; flex: 1; font-size: 13px;
  }
  input[type="checkbox"] { accent-color: var(--accent); }
  .buttons {
    display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px;
  }
  button {
    border: none; padding: 8px 16px; cursor: pointer; border-radius: 3px;
    font-size: 13px;
  }
  button.primary { background: var(--accent); color: #000; }
  button.secondary { background: var(--panel); color: var(--text); }
`;

const SCRIPT = `
  function send(result) {
    const message = { method: "close_and_send", params: [result] };
    if (window.webkit?.messageHandlers?.live) {
      window.webkit.messageHandlers.live.postMessage(message);
    } else if (window.chrome?.webview) {
      window.chrome.webview.postMessage(message);
    }
  }
  function cancel() { send("null"); }
  function submitForm() {
    const data = {};
    document.querySelectorAll("[name]").forEach((el) => {
      data[el.name] = el.type === "checkbox" ? el.checked : el.value;
    });
    send(JSON.stringify(data));
  }
`;

function page(title: string, body: string, buttons: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<script>${SCRIPT}</script>
<style>${STYLE}</style>
</head>
<body>
${body}
<div class="buttons">${buttons}</div>
</body>
</html>`;
}

function infoPage(title: string, subtitle: string, body: string): string {
  return page(
    title,
    `<h1>${escapeHtml(title)}</h1>
     <p class="subtitle">${escapeHtml(subtitle)}</p>
     <div class="result">${body}</div>`,
    `<button class="primary" onclick="cancel()">Close</button>`,
  );
}

function formPage(
  title: string,
  subtitle: string,
  fields: string,
  submitLabel: string,
): string {
  return page(
    title,
    `<h1>${escapeHtml(title)}</h1>
     <p class="subtitle">${escapeHtml(subtitle)}</p>
     <div class="result">${fields}</div>`,
    `<button class="secondary" onclick="cancel()">Cancel</button>
     <button class="primary" onclick="submitForm()">${escapeHtml(submitLabel)}</button>`,
  );
}

function select(
  name: string,
  values: { value: string; label?: string }[],
  selected?: string,
  attrs = "",
): string {
  const options = values
    .map(({ value, label }) => {
      const sel = value === selected ? " selected" : "";
      return `<option value="${escapeHtml(value)}"${sel}>${escapeHtml(label ?? value)}</option>`;
    })
    .join("");
  return `<select name="${escapeHtml(name)}" ${attrs}>${options}</select>`;
}

function field(label: string, control: string): string {
  return `<div class="field"><label>${escapeHtml(label)}</label>${control}</div>`;
}

const OCTAVES = ["2", "3", "4", "5", "6"].map((value) => ({
  value,
  label: value === "4" ? "4 (middle)" : value,
}));

export function renderKeyDialog(clipName: string, result: KeyResult): string {
  const recommendations = result.recommendations
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.tonic)} ${escapeHtml(r.scale)}</td>
        <td class="dim">${Math.round(r.fitness * 100)}%</td>
      </tr>`,
    )
    .join("");
  return infoPage(
    "Key Detection",
    `${clipName} — ${result.noteCount} notes (${result.noteNames.join(" ")})`,
    `<p class="big">${result.key ? escapeHtml(result.key) : "No key detected"}</p>
     <table>
       <tr><th>Scale candidates</th><th>Fit</th></tr>
       ${recommendations}
     </table>`,
  );
}

export function renderChordsDialog(
  clipName: string,
  result: ChordsResult,
): string {
  const rows = result.chords
    .map(
      (c) => `<tr>
        <td class="dim">${(1 + c.start / 4).toFixed(2)}</td>
        <td>${c.symbol ? escapeHtml(c.symbol) : "?"}</td>
        <td>${c.numeral ? escapeHtml(c.numeral) : "—"}</td>
        <td class="dim">${c.notes.map(escapeHtml).join(" ")}</td>
      </tr>`,
    )
    .join("");
  const keyNote = result.key ? ` — key of ${result.key}` : "";
  return infoPage(
    "Chord Detection",
    `${clipName} — ${result.chords.length} chords${keyNote}`,
    `<table>
       <tr><th>Bar</th><th>Chord</th><th>Numeral</th><th>Notes</th></tr>
       ${rows}
     </table>`,
  );
}

export function renderProgressionForm(options: Options): string {
  const progressionChoices = [
    ...Object.entries(options.progressions).map(([name, numerals]) => ({
      value: name,
      label: `${name}  (${numerals.join(" ")})`,
    })),
    { value: "custom", label: "Custom…" },
  ];
  const fields = [
    field("Key", select("tonic", options.tonics.map((value) => ({ value })), "C")),
    field("Mode", select("mode", options.scales.map((value) => ({ value })), "major")),
    field(
      "Progression",
      select("progression", progressionChoices, "I-V-vi-IV",
        `onchange="document.getElementById('custom-row').style.display = this.value === 'custom' ? '' : 'none'"`),
    ),
    `<div id="custom-row" style="display: none">${field(
      "Custom numerals",
      `<input type="text" name="customNumerals" placeholder="e.g. I vi ii V7">`,
    )}</div>`,
    field("Octave", select("octave", OCTAVES, "4")),
    field(
      "Beats per chord",
      select("beatsPerChord", [
        { value: "1", label: "1 (quarter)" },
        { value: "2", label: "2 (half bar)" },
        { value: "4", label: "4 (bar)" },
        { value: "8", label: "8 (two bars)" },
      ], "4"),
    ),
  ].join("");
  return formPage(
    "Generate Progression",
    "Creates a MIDI clip with the chosen chord progression.",
    fields,
    "Generate",
  );
}

export function renderScaleForm(options: Options): string {
  const fields = [
    field("Key", select("tonic", options.tonics.map((value) => ({ value })), "C")),
    field("Scale", select("scale", options.scales.map((value) => ({ value })), "major")),
    field("Octave", select("octave", OCTAVES, "4")),
    field(
      "Note length",
      select("noteDuration", [
        { value: "0.25", label: "16th" },
        { value: "0.5", label: "8th" },
        { value: "1", label: "Quarter" },
        { value: "2", label: "Half" },
      ], "0.5"),
    ),
    field(
      "Descend",
      `<input type="checkbox" name="descend" checked> <span class="dim">play back down after reaching the top</span>`,
    ),
  ].join("");
  return formPage(
    "Generate Scale",
    "Creates a MIDI clip running through the chosen scale.",
    fields,
    "Generate",
  );
}

export function renderConformForm(
  options: Options,
  detected: KeyResult,
): string {
  const detectedLine = detected.key
    ? `Detected key: ${detected.key}. Out-of-scale notes snap to the nearest scale tone.`
    : "Out-of-scale notes snap to the nearest scale tone.";
  const scaleDefault =
    detected.mode && options.scales.includes(detected.mode)
      ? detected.mode
      : "major";
  const fields = [
    field("Key", select("tonic", options.tonics.map((value) => ({ value })), detected.tonic ?? "C")),
    field("Scale", select("scale", options.scales.map((value) => ({ value })), scaleDefault)),
  ].join("");
  return formPage("Conform to Scale", detectedLine, fields, "Conform");
}

export function renderMessageDialog(title: string, message: string): string {
  return infoPage(title, "", `<p>${escapeHtml(message)}</p>`);
}

export function renderErrorDialog(message: string): string {
  return renderMessageDialog("pytheory", message);
}
