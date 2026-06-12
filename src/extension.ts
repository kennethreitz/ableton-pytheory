import {
  initialize,
  ClipSlot,
  MidiClip,
  type ActivationContext,
  type ExtensionContext,
  type Handle,
  type NoteDescription,
} from "@ableton-extensions/sdk";

import { analyze, getPython } from "./python.js";
import {
  renderChordsDialog,
  renderConformForm,
  renderErrorDialog,
  renderKeyDialog,
  renderMessageDialog,
  renderProgressionForm,
  renderScaleForm,
  type ChordsResult,
  type KeyResult,
  type Options,
} from "./dialogs.js";

const API_VERSION = "1.0.0";

type Context = ExtensionContext<typeof API_VERSION>;

interface GeneratedClip {
  notes: NoteDescription[];
  length: number;
  name: string;
}

export function activate(activation: ActivationContext) {
  const context = initialize(activation, API_VERSION);

  // Warm up the Python worker in the background so the first menu click
  // is snappy.
  try {
    getPython();
  } catch (error) {
    console.error("pytheory: failed to start Python runtime:", error);
  }

  const commands: [scope: "MidiClip" | "ClipSlot", label: string, id: string,
    run: (context: Context, handle: Handle) => Promise<void>][] = [
    ["MidiClip", "Detect Key", "pytheory.detect-key", detectKey],
    ["MidiClip", "Detect Chords", "pytheory.detect-chords", detectChords],
    ["MidiClip", "Conform to Scale…", "pytheory.conform", conformToScale],
    ["ClipSlot", "Generate Progression…", "pytheory.generate-progression", generateProgression],
    ["ClipSlot", "Generate Scale…", "pytheory.generate-scale", generateScale],
  ];

  for (const [scope, label, id, run] of commands) {
    context.commands.registerCommand(id, (handle) => {
      run(context, handle as Handle).catch(async (error) => {
        console.error(`pytheory: ${id} failed:`, error);
        await showDialog(context, renderErrorDialog(String(error)), 420, 220);
      });
    });
    context.ui.registerContextMenuAction(scope, label, id);
  }

  console.log("pytheory extension activated.");
}

async function detectKey(context: Context, handle: Handle) {
  const clip = context.getObjectFromHandle(handle, MidiClip);
  const clipName = clip.name;
  const notes = clip.notes;
  const result = (await context.ui.withinProgressDialog(
    "Detecting key…",
    {},
    () => analyze<KeyResult>("detect_key", notes),
  )) as KeyResult & { error?: string };
  const html = result.error
    ? renderErrorDialog(result.error)
    : renderKeyDialog(clipName, result);
  await showDialog(context, html, 420, 380);
}

async function detectChords(context: Context, handle: Handle) {
  const clip = context.getObjectFromHandle(handle, MidiClip);
  const clipName = clip.name;
  const notes = clip.notes;
  const result = (await context.ui.withinProgressDialog(
    "Detecting chords…",
    {},
    () => analyze<ChordsResult>("detect_chords", notes),
  )) as ChordsResult & { error?: string };
  const html = result.error
    ? renderErrorDialog(result.error)
    : renderChordsDialog(clipName, result);
  await showDialog(context, html, 520, 420);
}

async function conformToScale(context: Context, handle: Handle) {
  const clip = context.getObjectFromHandle(handle, MidiClip);
  const notes = clip.notes;
  if (notes.length === 0) {
    await showDialog(context, renderErrorDialog("This clip has no notes."), 420, 200);
    return;
  }

  const [options, detected] = (await context.ui.withinProgressDialog(
    "Analyzing…",
    {},
    () =>
      Promise.all([
        analyze<Options>("get_options", null),
        analyze<KeyResult>("detect_key", notes),
      ]),
  )) as [Options, KeyResult];

  const params = await showForm(context, renderConformForm(options, detected), 420, 260);
  if (!params) return;

  const result = await analyze<{ notes: NoteDescription[]; changed: number }>(
    "conform_to_scale",
    { notes, tonic: params.tonic, scale: params.scale },
  );
  if (result.error) {
    await showDialog(context, renderErrorDialog(result.error), 420, 200);
    return;
  }

  const scaleName = `${params.tonic} ${params.scale}`;
  if (result.changed === 0) {
    await showDialog(
      context,
      renderMessageDialog("Conform to Scale", `Already in ${scaleName} — nothing to change.`),
      420,
      200,
    );
    return;
  }

  context.withinTransaction(() => {
    clip.notes = result.notes;
  });
  await showDialog(
    context,
    renderMessageDialog(
      "Conform to Scale",
      `Moved ${result.changed} ${result.changed === 1 ? "note" : "notes"} into ${scaleName}.`,
    ),
    420,
    200,
  );
}

async function generateProgression(context: Context, handle: Handle) {
  const slot = context.getObjectFromHandle(handle, ClipSlot);
  if (slot.clip) {
    await showDialog(
      context,
      renderErrorDialog("This clip slot already has a clip — pick an empty one."),
      420,
      200,
    );
    return;
  }

  const options = await analyze<Options>("get_options", null);
  const params = await showForm(context, renderProgressionForm(options), 460, 360);
  if (!params) return;

  const numerals =
    params.progression === "custom"
      ? String(params.customNumerals ?? "").trim().split(/[\s,-]+/)
      : options.progressions[String(params.progression)];

  const generated = await analyze<GeneratedClip>("generate_progression", {
    tonic: params.tonic,
    mode: params.mode,
    numerals,
    octave: params.octave,
    beatsPerChord: params.beatsPerChord,
  });
  if (generated.error) {
    await showDialog(context, renderErrorDialog(generated.error), 420, 200);
    return;
  }
  await fillClip(context, slot, generated);
}

async function generateScale(context: Context, handle: Handle) {
  const slot = context.getObjectFromHandle(handle, ClipSlot);
  if (slot.clip) {
    await showDialog(
      context,
      renderErrorDialog("This clip slot already has a clip — pick an empty one."),
      420,
      200,
    );
    return;
  }

  const options = await analyze<Options>("get_options", null);
  const params = await showForm(context, renderScaleForm(options), 440, 320);
  if (!params) return;

  const generated = await analyze<GeneratedClip>("generate_scale", params);
  if (generated.error) {
    await showDialog(context, renderErrorDialog(generated.error), 420, 200);
    return;
  }
  await fillClip(context, slot, generated);
}

async function fillClip(
  context: Context,
  slot: ClipSlot<typeof API_VERSION>,
  generated: GeneratedClip,
) {
  const clip = await slot.createMidiClip(generated.length);
  context.withinTransaction(() => {
    clip.notes = generated.notes;
    clip.name = generated.name;
  });
}

/** Show a form dialog; returns the submitted values, or null on cancel. */
async function showForm(
  context: Context,
  html: string,
  width: number,
  height: number,
): Promise<Record<string, unknown> | null> {
  const result = await showDialog(context, html, width, height);
  try {
    return JSON.parse(result);
  } catch {
    return null;
  }
}

function showDialog(
  context: Context,
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
