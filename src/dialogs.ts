export interface KeyResult {
  key: string | null;
  noteNames: string[];
  noteCount: number;
  recommendations: { tonic: string; scale: string; fitness: number }[];
}

export interface ChordsResult {
  chords: { start: number; notes: string[]; name: string | null }[];
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<script>
  function close_() {
    const message = { method: "close_and_send", params: ["{}"] };
    if (window.webkit?.messageHandlers?.live) {
      window.webkit.messageHandlers.live.postMessage(message);
    } else if (window.chrome?.webview) {
      window.chrome.webview.postMessage(message);
    }
  }
</script>
<style>
  :root {
    --bg: #383838; --panel: #4E4E4E; --accent: #FFA500;
    --text: #FFFFFF; --dim: #B0B0B0; --border: #2C2C2C;
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
  button {
    background: var(--accent); border: none; color: #000;
    padding: 8px 16px; cursor: pointer; border-radius: 3px;
    align-self: flex-end; margin-top: 12px;
  }
</style>
</head>
<body>
${body}
<button onclick="close_()">Close</button>
</body>
</html>`;
}

export function renderKeyDialog(clipName: string, result: KeyResult): string {
  const recommendations = result.recommendations
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.tonic)} ${escapeHtml(r.scale)}</td>
        <td class="dim">${Math.round(r.fitness * 100)}%</td>
      </tr>`,
    )
    .join("");
  return page(
    "Key Detection",
    `<h1>Key Detection</h1>
     <p class="subtitle">${escapeHtml(clipName)} — ${result.noteCount} notes (${result.noteNames.map(escapeHtml).join(" ")})</p>
     <div class="result">
       <p class="big">${result.key ? escapeHtml(result.key) : "No key detected"}</p>
       <table>
         <tr><th>Scale candidates</th><th>Fit</th></tr>
         ${recommendations}
       </table>
     </div>`,
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
        <td>${c.name ? escapeHtml(c.name) : "?"}</td>
        <td class="dim">${c.notes.map(escapeHtml).join(" ")}</td>
      </tr>`,
    )
    .join("");
  return page(
    "Chord Detection",
    `<h1>Chord Detection</h1>
     <p class="subtitle">${escapeHtml(clipName)} — ${result.chords.length} chords</p>
     <div class="result">
       <table>
         <tr><th>Bar</th><th>Chord</th><th>Notes</th></tr>
         ${rows}
       </table>
     </div>`,
  );
}

export function renderErrorDialog(message: string): string {
  return page(
    "pytheory",
    `<h1>pytheory</h1>
     <div class="result"><p>${escapeHtml(message)}</p></div>`,
  );
}
