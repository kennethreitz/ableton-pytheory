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
  renderArpeggiateForm,
  renderChordsDialog,
  renderConformForm,
  renderDrumsForm,
  renderErrorDialog,
  renderHarmonizeForm,
  renderKeyDialog,
  renderMessageDialog,
  renderProgressionForm,
  renderScaleForm,
  renderTabsDialog,
  renderTabsForm,
  type ChordsResult,
  type KeyDefaults,
  type KeyResult,
  type Options,
  type TabsResult,
} from "./dialogs.js";

const API_VERSION = "1.0.0";

type Context = ExtensionContext<typeof API_VERSION>;

const TONICS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** The Set's key metadata (Live's scale settings), mapped to pytheory names. */
function songKey(context: Context, options: Options): KeyDefaults {
  try {
    const song = context.application.song;
    const tonic = TONICS[song.rootNote];
    if (!tonic) return { tonic: "C", scale: "major", source: "none" };
    const liveScale = song.scaleName.toLowerCase();
    const scale = options.scales.includes(liveScale)
      ? liveScale
      : liveScale.includes("minor")
        ? "minor"
        : "major";
    return { tonic, scale, source: "set" };
  } catch (error) {
    console.error("pytheory: couldn't read the Set's key:", error);
    return { tonic: "C", scale: "major", source: "none" };
  }
}

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
    ["MidiClip", "Guitar Tabs…", "pytheory.guitar-tabs", guitarTabs],
    ["MidiClip", "Harmonize…", "pytheory.harmonize", harmonize],
    ["MidiClip", "Arpeggiate…", "pytheory.arpeggiate", arpeggiate],
    ["MidiClip", "Conform to Scale…", "pytheory.conform", conformToScale],
    ["ClipSlot", "Generate Progression…", "pytheory.generate-progression", generateProgression],
    ["ClipSlot", "Generate Scale…", "pytheory.generate-scale", generateScale],
    ["ClipSlot", "Generate Drum Pattern…", "pytheory.generate-drums", generateDrums],
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

  // If the clip didn't reveal a key, fall back to the Set's key metadata.
  if (!detected.tonic) {
    const fromSet = songKey(context, options);
    if (fromSet.source === "set") {
      detected.tonic = fromSet.tonic;
      detected.mode = fromSet.scale;
    }
  }

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
  const params = await showForm(
    context,
    renderProgressionForm(options, songKey(context, options)),
    460,
    360,
  );
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
  const params = await showForm(
    context,
    renderScaleForm(options, songKey(context, options)),
    440,
    320,
  );
  if (!params) return;

  const generated = await analyze<GeneratedClip>("generate_scale", params);
  if (generated.error) {
    await showDialog(context, renderErrorDialog(generated.error), 420, 200);
    return;
  }
  await fillClip(context, slot, generated);
}

async function generateDrums(context: Context, handle: Handle) {
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
  const params = await showForm(context, renderDrumsForm(options), 440, 280);
  if (!params) return;

  const generated = await analyze<GeneratedClip>("generate_drums", params);
  if (generated.error) {
    await showDialog(context, renderErrorDialog(generated.error), 420, 200);
    return;
  }
  await fillClip(context, slot, generated);
}

async function guitarTabs(context: Context, handle: Handle) {
  const clip = context.getObjectFromHandle(handle, MidiClip);
  const clipName = clip.name;
  const notes = clip.notes;
  if (notes.length === 0) {
    await showDialog(context, renderErrorDialog("This clip has no notes."), 420, 200);
    return;
  }

  const params = await showForm(context, renderTabsForm(), 420, 220);
  if (!params) return;

  const result = await analyze<TabsResult>("guitar_tabs", {
    notes,
    instrument: params.instrument,
  });
  if (result.error) {
    await showDialog(context, renderErrorDialog(result.error), 420, 200);
    return;
  }
  await showDialog(context, renderTabsDialog(clipName, result), 560, 460);
}

async function harmonize(context: Context, handle: Handle) {
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

  // If the clip didn't reveal a key, fall back to the Set's key metadata.
  if (!detected.tonic) {
    const fromSet = songKey(context, options);
    if (fromSet.source === "set") {
      detected.tonic = fromSet.tonic;
      detected.mode = fromSet.scale;
    }
  }

  const params = await showForm(
    context,
    renderHarmonizeForm(options, detected),
    420,
    320,
  );
  if (!params) return;

  const result = await analyze<{ notes: NoteDescription[]; added: number }>(
    "harmonize",
    { notes, ...params },
  );
  if (result.error) {
    await showDialog(context, renderErrorDialog(result.error), 420, 200);
    return;
  }

  context.withinTransaction(() => {
    clip.notes = result.notes;
  });
  await showDialog(
    context,
    renderMessageDialog(
      "Harmonize",
      `Added ${result.added} harmony ${result.added === 1 ? "note" : "notes"}.`,
    ),
    420,
    200,
  );
}

async function arpeggiate(context: Context, handle: Handle) {
  const clip = context.getObjectFromHandle(handle, MidiClip);
  const notes = clip.notes;
  if (notes.length === 0) {
    await showDialog(context, renderErrorDialog("This clip has no notes."), 420, 200);
    return;
  }

  const params = await showForm(context, renderArpeggiateForm(), 420, 260);
  if (!params) return;

  const result = await analyze<{ notes: NoteDescription[]; arpeggiated: number }>(
    "arpeggiate",
    { notes, ...params },
  );
  if (result.error) {
    await showDialog(context, renderErrorDialog(result.error), 420, 200);
    return;
  }

  context.withinTransaction(() => {
    clip.notes = result.notes;
  });
  await showDialog(
    context,
    renderMessageDialog(
      "Arpeggiate",
      `Arpeggiated ${result.arpeggiated} ${result.arpeggiated === 1 ? "chord" : "chords"}.`,
    ),
    420,
    200,
  );
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
