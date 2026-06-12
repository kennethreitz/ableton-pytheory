import {
  initialize,
  MidiClip,
  type ActivationContext,
  type ExtensionContext,
  type Handle,
} from "@ableton-extensions/sdk";

import { analyze, getPython } from "./python.js";
import {
  renderChordsDialog,
  renderErrorDialog,
  renderKeyDialog,
  type ChordsResult,
  type KeyResult,
} from "./dialogs.js";

const API_VERSION = "1.0.0";

export function activate(activation: ActivationContext) {
  const context = initialize(activation, API_VERSION);

  // Warm up the Python worker in the background so the first menu click
  // is snappy.
  try {
    getPython();
  } catch (error) {
    console.error("pytheory: failed to start Python runtime:", error);
  }

  context.commands.registerCommand("pytheory.detect-key", (handle) => {
    void detectKey(context, handle as Handle);
  });
  context.commands.registerCommand("pytheory.detect-chords", (handle) => {
    void detectChords(context, handle as Handle);
  });

  context.ui.registerContextMenuAction(
    "MidiClip",
    "Detect Key",
    "pytheory.detect-key",
  );
  context.ui.registerContextMenuAction(
    "MidiClip",
    "Detect Chords",
    "pytheory.detect-chords",
  );

  console.log("pytheory extension activated.");
}

async function detectKey(
  context: ExtensionContext<typeof API_VERSION>,
  handle: Handle,
) {
  const clip = context.getObjectFromHandle(handle, MidiClip);
  const clipName = clip.name;
  const notes = clip.notes;
  try {
    const result = (await context.ui.withinProgressDialog(
      "Detecting key…",
      {},
      () => analyze<KeyResult>("detect_key", notes),
    )) as KeyResult & { error?: string };
    const html = result.error
      ? renderErrorDialog(result.error)
      : renderKeyDialog(clipName, result);
    await showDialog(context, html, 420, 380);
  } catch (error) {
    console.error("pytheory: key detection failed:", error);
    await showDialog(context, renderErrorDialog(String(error)), 420, 220);
  }
}

async function detectChords(
  context: ExtensionContext<typeof API_VERSION>,
  handle: Handle,
) {
  const clip = context.getObjectFromHandle(handle, MidiClip);
  const clipName = clip.name;
  const notes = clip.notes;
  try {
    const result = (await context.ui.withinProgressDialog(
      "Detecting chords…",
      {},
      () => analyze<ChordsResult>("detect_chords", notes),
    )) as ChordsResult & { error?: string };
    const html = result.error
      ? renderErrorDialog(result.error)
      : renderChordsDialog(clipName, result);
    await showDialog(context, html, 460, 420);
  } catch (error) {
    console.error("pytheory: chord detection failed:", error);
    await showDialog(context, renderErrorDialog(String(error)), 420, 220);
  }
}

function showDialog(
  context: ExtensionContext<typeof API_VERSION>,
  html: string,
  width: number,
  height: number,
) {
  return context.ui.showModalDialog(
    `data:text/html,${encodeURIComponent(html)}`,
    width,
    height,
  );
}
