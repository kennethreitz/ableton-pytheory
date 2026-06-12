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
  cadences: { bar: number; type: string; motion: string }[];
}

export interface Options {
  tonics: string[];
  scales: string[];
  progressions: Record<string, string[]>;
  drumPatterns: string[];
  drumFills: string[];
  instruments: string[];
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
  const cadences = result.cadences?.length
    ? `<p style="color: var(--accent); margin: 12px 0 4px;">Cadences</p>
       <table>${result.cadences
         .map(
           (c) => `<tr>
             <td class="dim">bar ${c.bar}</td>
             <td>${escapeHtml(c.type)}</td>
             <td class="dim">${escapeHtml(c.motion)}</td>
           </tr>`,
         )
         .join("")}</table>`
    : "";
  return infoPage(
    "Chord Detection",
    `${clipName} — ${result.chords.length} chords${keyNote}`,
    `<table>
       <tr><th>Bar</th><th>Chord</th><th>Numeral</th><th>Notes</th></tr>
       ${rows}
     </table>
     ${cadences}`,
  );
}

export interface KeyDefaults {
  tonic: string;
  scale: string;
  source: "set" | "none";
}

function keySubtitle(base: string, defaults: KeyDefaults): string {
  return defaults.source === "set"
    ? `${base} Key prefilled from the Set: ${defaults.tonic} ${defaults.scale}.`
    : base;
}

export function renderProgressionForm(
  options: Options,
  defaults: KeyDefaults,
): string {
  const progressionChoices = [
    ...Object.entries(options.progressions).map(([name, numerals]) => ({
      value: name,
      label: `${name}  (${numerals.join(" ")})`,
    })),
    { value: "custom", label: "Custom Roman numerals…" },
    { value: "symbols", label: "Chord symbols…" },
    { value: "random", label: "Surprise me (random walk)" },
  ];
  const fields = [
    field("Key", select("tonic", options.tonics.map((value) => ({ value })), defaults.tonic)),
    field("Mode", select("mode", options.scales.map((value) => ({ value })), defaults.scale)),
    field(
      "Progression",
      select("progression", progressionChoices, "I-V-vi-IV",
        `onchange="
          document.getElementById('custom-row').style.display = this.value === 'custom' ? '' : 'none';
          document.getElementById('symbols-row').style.display = this.value === 'symbols' ? '' : 'none';
        "`),
    ),
    `<div id="custom-row" style="display: none">${field(
      "Custom numerals",
      `<input type="text" name="customNumerals" placeholder="e.g. I vi ii V7">`,
    )}</div>`,
    `<div id="symbols-row" style="display: none">${field(
      "Chord symbols",
      `<input type="text" name="customSymbols" placeholder="e.g. Am7 D7 Gmaj7">`,
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
    keySubtitle("Creates a MIDI clip with the chosen chord progression.", defaults),
    fields,
    "Generate",
  );
}

export function renderScaleForm(options: Options, defaults: KeyDefaults): string {
  const fields = [
    field("Key", select("tonic", options.tonics.map((value) => ({ value })), defaults.tonic)),
    field("Scale", select("scale", options.scales.map((value) => ({ value })), defaults.scale)),
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
    keySubtitle("Creates a MIDI clip running through the chosen scale.", defaults),
    fields,
    "Generate",
  );
}

export function renderDrumsForm(options: Options): string {
  const fields = [
    field(
      "Pattern",
      select("pattern", options.drumPatterns.map((value) => ({ value })), "house"),
    ),
    field(
      "Repeats",
      select("repeats", [
        { value: "1" },
        { value: "2" },
        { value: "4" },
        { value: "8" },
      ], "4"),
    ),
    field(
      "Fill (last cycle)",
      select("fill", [
        { value: "", label: "None" },
        ...options.drumFills.map((value) => ({ value })),
      ], ""),
    ),
  ].join("");
  return formPage(
    "Generate Drum Pattern",
    "Creates a MIDI clip on the General MIDI drum map (kick = C1).",
    fields,
    "Generate",
  );
}

export function renderHarmonizeForm(
  options: Options,
  detected: KeyResult,
): string {
  const scaleDefault =
    detected.mode && options.scales.includes(detected.mode)
      ? detected.mode
      : "major";
  const fields = [
    field(
      "Interval",
      select("interval", [
        { value: "third", label: "Diatonic third" },
        { value: "sixth", label: "Diatonic sixth" },
        { value: "triad", label: "Full triad" },
        { value: "octave", label: "Octave" },
      ], "third"),
    ),
    field(
      "Direction",
      select("direction", [{ value: "above" }, { value: "below" }], "above"),
    ),
    field("Key", select("tonic", options.tonics.map((value) => ({ value })), detected.tonic ?? "C")),
    field("Scale", select("scale", options.scales.map((value) => ({ value })), scaleDefault)),
  ].join("");
  const subtitle = detected.key
    ? `Detected key: ${detected.key}. Adds harmony notes to the melody.`
    : "Adds harmony notes to the melody.";
  return formPage("Harmonize", subtitle, fields, "Harmonize");
}

export function renderArpeggiateForm(): string {
  const fields = [
    field(
      "Style",
      select("style", [
        { value: "up", label: "Up" },
        { value: "down", label: "Down" },
        { value: "updown", label: "Up & down" },
      ], "up"),
    ),
    field(
      "Rate",
      select("rate", [
        { value: "0.125", label: "32nd" },
        { value: "0.25", label: "16th" },
        { value: "0.5", label: "8th" },
        { value: "1", label: "Quarter" },
      ], "0.25"),
    ),
  ].join("");
  return formPage(
    "Arpeggiate",
    "Replaces each block chord with an arpeggio over its duration.",
    fields,
    "Arpeggiate",
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

export interface TabsResult {
  instrument: string;
  key: string | null;
  scaleDiagram: string | null;
  chords: { symbol: string; tab: string | null; bars: number[] }[];
}

export function renderTabsForm(): string {
  const fields = [
    field(
      "Instrument",
      select("instrument", [
        { value: "guitar", label: "Guitar" },
        { value: "ukulele", label: "Ukulele" },
        { value: "bass", label: "Bass" },
        { value: "mandolin", label: "Mandolin" },
        { value: "banjo", label: "Banjo" },
      ], "guitar"),
    ),
  ].join("");
  return formPage(
    "Guitar Tabs",
    "Shows fingering charts for the chords in this clip.",
    fields,
    "Show Tabs",
  );
}

export function renderTabsDialog(clipName: string, result: TabsResult): string {
  const cards = result.chords
    .map((c) => {
      const body = c.tab
        ? `<pre class="tab">${escapeHtml(c.tab)}</pre>`
        : `<p class="dim">no chart</p>`;
      return `<div class="card">
        <p class="chord-name">${escapeHtml(c.symbol)}</p>
        ${body}
        <p class="dim">bar ${c.bars.join(", ")}</p>
      </div>`;
    })
    .join("");
  const keyNote = result.key ? ` — key of ${result.key}` : "";
  const diagram = result.scaleDiagram
    ? `<p class="chord-name">${escapeHtml(result.key ?? "")} scale</p>
       <pre class="tab diagram">${escapeHtml(result.scaleDiagram)}</pre>`
    : "";
  return infoPage(
    `${result.instrument[0].toUpperCase()}${result.instrument.slice(1)} Tabs`,
    `${clipName}${keyNote}`,
    `<style>
       .cards { display: flex; flex-wrap: wrap; gap: 12px; }
       .card {
         background: var(--input-bg); border-radius: 4px;
         padding: 8px 12px; min-width: 110px;
       }
       .chord-name { color: var(--accent); font-size: 15px; margin: 0 0 6px; }
       .tab { font-family: monospace; font-size: 12px; line-height: 1.5; margin: 0; }
       .diagram { overflow-x: auto; margin-bottom: 14px; }
       .card .dim { margin: 6px 0 0; font-size: 11px; }
     </style>
     ${diagram}
     <div class="cards">${cards}</div>`,
  );
}

export interface MelodyAnalysis {
  key: string;
  noteCount: number;
  inScalePercent: number;
  low: string;
  high: string;
  histogram: [string, number][];
  rows: { name: string; degree: string; role: string | null; start: number }[];
  truncated: number;
}

export function renderMelodyAnalysisDialog(
  clipName: string,
  result: MelodyAnalysis,
): string {
  const histogram = result.histogram
    .map(([degree, count]) => `${degree}×${count}`)
    .join("  ");
  const rows = result.rows
    .map(
      (r) => `<tr>
        <td class="dim">${(1 + r.start / 4).toFixed(2)}</td>
        <td>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.degree)}</td>
        <td class="dim">${r.role ? escapeHtml(r.role) : ""}</td>
      </tr>`,
    )
    .join("");
  const truncated = result.truncated
    ? `<p class="dim">…and ${result.truncated} more notes.</p>`
    : "";
  return infoPage(
    "Melody Analysis",
    `${clipName} — key of ${result.key}`,
    `<p>${result.noteCount} notes, ${result.inScalePercent}% in scale,
        range ${escapeHtml(result.low)}–${escapeHtml(result.high)}</p>
     <p class="dim">Degrees: ${escapeHtml(histogram)}</p>
     <table>
       <tr><th>Bar</th><th>Note</th><th>Degree</th><th>Role</th></tr>
       ${rows}
     </table>
     ${truncated}`,
  );
}

export interface SuggestionsResult {
  key: string;
  lastChord: { symbol: string; numeral: string };
  suggestions: { numeral: string; symbol: string; notes: string[]; count: number }[];
}

export function renderSuggestionsDialog(result: SuggestionsResult): string {
  const rows = result.suggestions
    .map(
      (s) => `<tr>
        <td>${escapeHtml(s.symbol)}</td>
        <td>${escapeHtml(s.numeral)}</td>
        <td class="dim">${s.notes.map(escapeHtml).join(" ")}</td>
        <td class="dim">${s.count > 0 ? `seen ${s.count}×` : "diatonic"}</td>
      </tr>`,
    )
    .join("");
  return infoPage(
    "Suggest Next Chord",
    `Key of ${result.key} — after ${result.lastChord.symbol} (${result.lastChord.numeral})`,
    `<table>
       <tr><th>Chord</th><th>Numeral</th><th>Notes</th><th>Why</th></tr>
       ${rows}
     </table>
     <p class="dim">Ranked by how often this move appears in pytheory's progression corpus.</p>`,
  );
}

export interface SubstitutionsResult {
  key: string | null;
  chords: {
    symbol: string;
    substitutions: { symbol: string; reason: string }[];
  }[];
}

export function renderSubstitutionsDialog(
  clipName: string,
  result: SubstitutionsResult,
): string {
  const sections = result.chords
    .map((c) => {
      const subs = c.substitutions
        .map(
          (s) => `<tr>
            <td>${escapeHtml(s.symbol)}</td>
            <td class="dim">${escapeHtml(s.reason)}</td>
          </tr>`,
        )
        .join("");
      return `<p class="chord-head">${escapeHtml(c.symbol)}</p>
        <table>${subs}</table>`;
    })
    .join("");
  const keyNote = result.key ? ` — key of ${result.key}` : "";
  return infoPage(
    "Chord Substitutions",
    `${clipName}${keyNote}`,
    `<style>
       .chord-head { color: var(--accent); font-size: 15px; margin: 10px 0 4px; }
       .chord-head:first-child { margin-top: 0; }
     </style>
     ${sections}`,
  );
}

export function renderMelodyForm(
  options: Options,
  defaults: KeyDefaults,
): string {
  const fields = [
    field("Key", select("tonic", options.tonics.map((value) => ({ value })), defaults.tonic)),
    field("Scale", select("scale", options.scales.map((value) => ({ value })), defaults.scale)),
    field("Octave", select("octave", OCTAVES, "4")),
    field(
      "Bars",
      select("bars", [
        { value: "1" },
        { value: "2" },
        { value: "4" },
        { value: "8" },
      ], "4"),
    ),
    field(
      "Density",
      select("density", [
        { value: "sparse", label: "Sparse (quarters and halves)" },
        { value: "medium", label: "Medium (eighths)" },
        { value: "busy", label: "Busy (sixteenths)" },
      ], "medium"),
    ),
  ].join("");
  return formPage(
    "Generate Melody",
    keySubtitle(
      "Creates a random melody: stepwise motion, occasional leaps, ends on the tonic.",
      defaults,
    ),
    fields,
    "Generate",
  );
}

export function renderTransposeForm(
  options: Options,
  detected: KeyResult,
): string {
  const scaleDefault =
    detected.mode && options.scales.includes(detected.mode)
      ? detected.mode
      : "major";
  const scaleChoices = options.scales.map((value) => ({ value }));
  const tonicChoices = options.tonics.map((value) => ({ value }));
  const fields = [
    field("From key", select("sourceTonic", tonicChoices, detected.tonic ?? "C")),
    field("From scale", select("sourceScale", scaleChoices, scaleDefault)),
    field("To key", select("targetTonic", tonicChoices, detected.tonic ?? "C")),
    field("To scale", select("targetScale", scaleChoices, scaleDefault)),
  ].join("");
  const subtitle = detected.key
    ? `Detected key: ${detected.key}. Maps notes by scale degree (C major → C minor moves E to E♭).`
    : "Maps notes by scale degree (C major → C minor moves E to E♭).";
  return formPage("Transpose to Key", subtitle, fields, "Transpose");
}

export function renderRenderAudioForm(options: Options): string {
  const fields = [
    field(
      "Instrument",
      select("instrument", options.instruments.map((value) => ({ value })), "piano"),
    ),
  ].join("");
  return formPage(
    "Render to Audio",
    "Renders this clip with pytheory's synth engine onto a new audio track.",
    fields,
    "Render",
  );
}

export function renderSketchForm(
  options: Options,
  defaults: KeyDefaults,
): string {
  const progressionChoices = [
    { value: "random", label: "Surprise me (random walk)" },
    ...Object.entries(options.progressions).map(([name, numerals]) => ({
      value: name,
      label: `${name}  (${numerals.join(" ")})`,
    })),
  ];
  const fields = [
    field("Key", select("tonic", options.tonics.map((value) => ({ value })), defaults.tonic)),
    field("Mode", select("mode", options.scales.map((value) => ({ value })), defaults.scale)),
    field("Progression", select("progression", progressionChoices, "random")),
    field(
      "Drums",
      select("drumPattern", options.drumPatterns.map((value) => ({ value })), "house"),
    ),
  ].join("");
  return formPage(
    "Generate Song Sketch",
    keySubtitle(
      "Creates four tracks at this scene: chords, bass, melody, and drums.",
      defaults,
    ),
    fields,
    "Generate",
  );
}

export function renderAudioToMidiForm(): string {
  const fields = [
    field(
      "Mode",
      select("split", [
        { value: "", label: "Single melody line" },
        { value: "yes", label: "Split bass + melody (full mixes)" },
      ], ""),
    ),
    field(
      "Quantize",
      select("quantize", [
        { value: "", label: "As performed" },
        { value: "0.25", label: "16th notes" },
        { value: "0.5", label: "8th notes" },
      ], "0.25"),
    ),
  ].join("");
  return formPage(
    "Convert to MIDI",
    "Transcribes this audio clip onto new MIDI tracks (pitched material only).",
    fields,
    "Convert",
  );
}

export function renderBasslineForm(): string {
  const fields = [
    field(
      "Style",
      select("style", [
        { value: "root-fifth", label: "Root & fifth" },
        { value: "roots", label: "Roots only" },
        { value: "walking", label: "Walking (jazz)" },
        { value: "arpeggio", label: "Arpeggiated (eighths)" },
      ], "root-fifth"),
    ),
    field(
      "Octave",
      select("octave", [
        { value: "1", label: "1 (low)" },
        { value: "2", label: "2" },
        { value: "3", label: "3" },
      ], "2"),
    ),
  ].join("");
  return formPage(
    "Generate Bassline",
    "Follows this clip's chords onto a new MIDI track.",
    fields,
    "Generate",
  );
}

export interface NotationResult {
  abc: string;
  lilypond: string;
  key: string | null;
}

/**
 * Full notation page: abcjs is inlined and renders the ABC to SVG on a
 * white "paper" card; the LilyPond source sits below for copying.
 * Served from a temp file via file:// (too big for a data: URL).
 */
export function renderNotationPage(
  clipName: string,
  result: NotationResult,
  lilypondPath: string,
  abcjsSource: string,
): string {
  const keyNote = result.key ? ` — key of ${result.key}` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Notation</title>
<script>${SCRIPT}</script>
<style>${STYLE}
  /* abcjs draws with currentColor — without this the notation inherits
     the dialog's white text and vanishes on the white paper. */
  #paper {
    background: #FDFBF7; color: #1A1A1A;
    border-radius: 6px; padding: 18px 14px;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
  }
  #paper .abcjs-title { fill: #D98200; }
  #paper .abcjs-tempo { fill: #777777; }
  #paper .abcjs-bar { fill: #444444; }
  textarea {
    width: 100%; height: 140px; box-sizing: border-box;
    background: var(--input-bg); color: #9ECE6A;
    border: 1px solid var(--border); border-radius: 3px;
    font-family: monospace; font-size: 11px; padding: 6px;
  }
  h2 { font-size: 13px; margin: 14px 0 6px; color: var(--accent); }
  h2 .dim { color: var(--dim); font-weight: normal; }
</style>
</head>
<body>
<h1>Notation</h1>
<p class="subtitle">${escapeHtml(clipName)}${escapeHtml(keyNote)}</p>
<div class="result">
  <div id="paper"></div>
  <h2>LilyPond source <span class="dim">(saved to ${escapeHtml(lilypondPath)})</span></h2>
  <textarea readonly id="ly">${escapeHtml(result.lilypond)}</textarea>
</div>
<div class="buttons">
  <button class="secondary" onclick="document.getElementById('ly').select(); document.execCommand('copy')">Copy LilyPond</button>
  <button class="primary" onclick="cancel()">Close</button>
</div>
<script>${abcjsSource}</script>
<script>
  ABCJS.renderAbc("paper", ${JSON.stringify(result.abc)}, {
    responsive: "resize",
    staffwidth: 640,
  });
</script>
</body>
</html>`;
}

export interface AudioDetectResult {
  key: string | null;
  tempo: number | null;
  chords: { start: number; duration: number; symbol: string }[];
}

export function renderAudioDetectDialog(
  clipName: string,
  result: AudioDetectResult,
): string {
  const rows = result.chords
    .map(
      (c) => `<tr>
        <td class="dim">${(1 + c.start / 4).toFixed(2)}</td>
        <td>${escapeHtml(c.symbol)}</td>
        <td class="dim">${c.duration} beats</td>
      </tr>`,
    )
    .join("");
  const tempo = result.tempo ? `, ~${result.tempo} BPM` : "";
  return infoPage(
    "Audio Analysis",
    `${clipName}${tempo}`,
    `<p class="big">${result.key ? escapeHtml(result.key) : "No key detected"}</p>
     <table>
       <tr><th>Bar</th><th>Chord</th><th>Length</th></tr>
       ${rows}
     </table>`,
  );
}

export interface SamplePitchResult {
  note: string;
  frequency: number;
  cents: number;
  midi: number;
  setTonic?: string;
  transpose?: number;
}

export function renderSamplePitchDialog(
  sampleName: string,
  result: SamplePitchResult,
): string {
  const centsNote =
    result.cents === 0 ? "in tune" : `${result.cents > 0 ? "+" : ""}${result.cents} cents`;
  let tuning = "";
  if (result.setTonic !== undefined && result.transpose !== undefined) {
    tuning =
      result.transpose === 0
        ? `<p>Already on the Set's tonic (${escapeHtml(result.setTonic)}).</p>`
        : `<p>To reach the Set's tonic (${escapeHtml(result.setTonic)}):
             transpose <b>${result.transpose > 0 ? "+" : ""}${result.transpose} st</b>.</p>`;
  }
  return infoPage(
    "Sample Pitch",
    sampleName,
    `<p class="big">${escapeHtml(result.note)} <span class="dim">(${result.frequency} Hz, ${escapeHtml(centsNote)})</span></p>
     ${tuning}`,
  );
}

export interface SceneKeyResult {
  key: string | null;
  clips: { name: string; key: string | null }[];
}

export function renderSceneKeyDialog(
  sceneName: string,
  result: SceneKeyResult,
): string {
  const rows = result.clips
    .map(
      (c) => `<tr>
        <td>${escapeHtml(c.name)}</td>
        <td class="dim">${c.key ? escapeHtml(c.key) : "—"}</td>
      </tr>`,
    )
    .join("");
  return infoPage(
    "Scene Key",
    sceneName,
    `<p class="big">${result.key ? escapeHtml(result.key) : "No key detected"}</p>
     <table>
       <tr><th>Clip</th><th>Key</th></tr>
       ${rows}
     </table>`,
  );
}

export function renderMessageDialog(title: string, message: string): string {
  return infoPage(title, "", `<p>${escapeHtml(message)}</p>`);
}

export function renderErrorDialog(message: string): string {
  return renderMessageDialog("pytheory", message);
}
