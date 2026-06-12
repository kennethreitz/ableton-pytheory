import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import {
  initialize,
  ClipSlot,
  MidiClip,
  MidiTrack,
  type ActivationContext,
  type ExtensionContext,
  type Handle,
  type NoteDescription,
} from "@ableton-extensions/sdk";

import { analyze, getPython } from "./python.js";
import {
  renderArpeggiateForm,
  renderBasslineForm,
  renderChordsDialog,
  renderConformForm,
  renderDrumsForm,
  renderErrorDialog,
  renderHarmonizeForm,
  renderKeyDialog,
  renderMelodyAnalysisDialog,
  renderMelodyForm,
  renderMessageDialog,
  renderNotationPage,
  renderProgressionForm,
  renderRenderAudioForm,
  renderScaleForm,
  renderSubstitutionsDialog,
  renderSuggestionsDialog,
  renderTabsDialog,
  renderTabsForm,
  renderTransposeForm,
  type ChordsResult,
  type KeyDefaults,
  type KeyResult,
  type MelodyAnalysis,
  type NotationResult,
  type Options,
  type SubstitutionsResult,
  type SuggestionsResult,
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

/**
 * A directory we're allowed to write to. The host provides temp/storage
 * directories; under `extensions-cli run` without flags they're undefined,
 * so fall back to the OS temp dir during development.
 */
function writableDir(context: Context): string {
  return (
    context.environment.tempDirectory ??
    context.environment.storageDirectory ??
    os.tmpdir()
  );
}

/**
 * A clip slot on a just-created track. The host may not have populated the
 * new track's slots yet, so poll briefly instead of failing (or worse,
 * silently doing nothing).
 */
async function slotOnNewTrack(
  track: { clipSlots: ClipSlot<typeof API_VERSION>[] },
  sceneIndex: number,
): Promise<ClipSlot<typeof API_VERSION> | null> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const slots = track.clipSlots;
    if (slots.length > 0) {
      return slots[Math.min(sceneIndex, slots.length - 1)] ?? null;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
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
    ["MidiClip", "Analyze Melody", "pytheory.analyze-melody", analyzeMelody],
    ["MidiClip", "Suggest Next Chord", "pytheory.suggest-next", suggestNextChord],
    ["MidiClip", "Chord Substitutions", "pytheory.substitutions", chordSubstitutions],
    ["MidiClip", "Negative Harmony", "pytheory.negative-harmony", negativeHarmony],
    ["MidiClip", "Show Notation", "pytheory.notation", showNotation],
    ["MidiClip", "Generate Bassline…", "pytheory.bassline", generateBassline],
    ["MidiClip", "Guitar Tabs…", "pytheory.guitar-tabs", guitarTabs],
    ["MidiClip", "Harmonize…", "pytheory.harmonize", harmonize],
    ["MidiClip", "Arpeggiate…", "pytheory.arpeggiate", arpeggiate],
    ["MidiClip", "Conform to Scale…", "pytheory.conform", conformToScale],
    ["MidiClip", "Transpose to Key…", "pytheory.transpose", transposeToKey],
    ["MidiClip", "Smooth Voicings", "pytheory.smooth-voicings", smoothVoicings],
    ["MidiClip", "Render to Audio…", "pytheory.render-audio", renderAudio],
    ["ClipSlot", "Generate Progression…", "pytheory.generate-progression", generateProgression],
    ["ClipSlot", "Generate Scale…", "pytheory.generate-scale", generateScale],
    ["ClipSlot", "Generate Drum Pattern…", "pytheory.generate-drums", generateDrums],
    ["ClipSlot", "Generate Melody…", "pytheory.generate-melody", generateMelody],
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

async function analyzeMelody(context: Context, handle: Handle) {
  const clip = context.getObjectFromHandle(handle, MidiClip);
  const clipName = clip.name;
  const notes = clip.notes;
  const result = (await context.ui.withinProgressDialog(
    "Analyzing melody…",
    {},
    () => analyze<MelodyAnalysis>("analyze_melody", notes),
  )) as MelodyAnalysis & { error?: string };
  const html = result.error
    ? renderErrorDialog(result.error)
    : renderMelodyAnalysisDialog(clipName, result);
  await showDialog(context, html, 460, 480);
}

async function suggestNextChord(context: Context, handle: Handle) {
  const clip = context.getObjectFromHandle(handle, MidiClip);
  const notes = clip.notes;
  const result = (await context.ui.withinProgressDialog(
    "Consulting the corpus…",
    {},
    () => analyze<SuggestionsResult>("suggest_next_chord", notes),
  )) as SuggestionsResult & { error?: string };
  const html = result.error
    ? renderErrorDialog(result.error)
    : renderSuggestionsDialog(result);
  await showDialog(context, html, 480, 380);
}

async function chordSubstitutions(context: Context, handle: Handle) {
  const clip = context.getObjectFromHandle(handle, MidiClip);
  const clipName = clip.name;
  const notes = clip.notes;
  const result = (await context.ui.withinProgressDialog(
    "Finding substitutions…",
    {},
    () => analyze<SubstitutionsResult>("chord_substitutions", notes),
  )) as SubstitutionsResult & { error?: string };
  const html = result.error
    ? renderErrorDialog(result.error)
    : renderSubstitutionsDialog(clipName, result);
  await showDialog(context, html, 480, 460);
}

async function negativeHarmony(context: Context, handle: Handle) {
  const clip = context.getObjectFromHandle(handle, MidiClip);
  const notes = clip.notes;
  if (notes.length === 0) {
    await showDialog(context, renderErrorDialog("This clip has no notes."), 420, 200);
    return;
  }

  const [options, detected] = (await context.ui.withinProgressDialog(
    "Mirroring…",
    {},
    () =>
      Promise.all([
        analyze<Options>("get_options", null),
        analyze<KeyResult>("detect_key", notes),
      ]),
  )) as [Options, KeyResult];

  const tonic = detected.tonic ?? songKey(context, options).tonic;
  const result = await analyze<{ notes: NoteDescription[]; changed: number }>(
    "negative_harmony",
    { notes, tonic },
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
      "Negative Harmony",
      `Mirrored ${result.changed} ${result.changed === 1 ? "note" : "notes"} around the ${tonic} tonic–dominant axis. Run it again to undo musically.`,
    ),
    440,
    200,
  );
}

async function generateMelody(context: Context, handle: Handle) {
  const slot = context.getObjectFromHandle(handle, ClipSlot);
  if (!(await usableMidiSlot(context, slot))) return;

  const options = await analyze<Options>("get_options", null);
  const params = await showForm(
    context,
    renderMelodyForm(options, songKey(context, options)),
    460,
    340,
  );
  if (!params) return;

  const generated = await analyze<GeneratedClip>("generate_melody", params);
  if (generated.error) {
    await showDialog(context, renderErrorDialog(generated.error), 420, 200);
    return;
  }
  await fillClip(context, slot, generated);
}

async function showNotation(context: Context, handle: Handle) {
  const clip = context.getObjectFromHandle(handle, MidiClip);
  const clipName = clip.name;
  const notes = clip.notes;
  if (notes.length === 0) {
    await showDialog(context, renderErrorDialog("This clip has no notes."), 420, 200);
    return;
  }

  const result = (await context.ui.withinProgressDialog(
    "Engraving…",
    {},
    () =>
      analyze<NotationResult>("notation", {
        notes,
        title: clipName,
        bpm: context.application.song.tempo,
      }),
  )) as NotationResult & { error?: string };
  if (result.error) {
    await showDialog(context, renderErrorDialog(result.error), 420, 200);
    return;
  }

  const dir = writableDir(context);
  const safeName = clipName.replace(/[^\w-]+/g, "_") || "clip";
  const lilypondPath = path.join(dir, `${safeName}.ly`);
  fs.writeFileSync(lilypondPath, result.lilypond);

  // The notation page inlines abcjs (~500 KB) — far too big for a data:
  // URL, so serve it from a temp file instead.
  const abcjsSource = fs.readFileSync(path.join(__dirname, "abcjs.js"), "utf8");
  const html = renderNotationPage(clipName, result, lilypondPath, abcjsSource);
  const htmlPath = path.join(dir, `pytheory-notation-${Date.now()}.html`);
  fs.writeFileSync(htmlPath, html);
  try {
    await context.ui.showModalDialog(pathToFileURL(htmlPath).href, 760, 600);
  } finally {
    fs.rmSync(htmlPath, { force: true });
  }
}

async function generateBassline(context: Context, handle: Handle) {
  const clip = context.getObjectFromHandle(handle, MidiClip);
  const clipName = clip.name;
  const notes = clip.notes;
  if (notes.length === 0) {
    await showDialog(context, renderErrorDialog("This clip has no notes."), 420, 200);
    return;
  }

  const params = await showForm(context, renderBasslineForm(), 420, 260);
  if (!params) return;

  const generated = await analyze<GeneratedClip>("generate_bassline", {
    notes,
    style: params.style,
    octave: params.octave,
  });
  if (generated.error) {
    await showDialog(context, renderErrorDialog(generated.error), 420, 200);
    return;
  }

  // Put the bassline on a fresh MIDI track, at the same scene as the
  // source clip when we can find it.
  const song = context.application.song;
  let sceneIndex = 0;
  for (const track of song.tracks) {
    const index = track.clipSlots.findIndex((slot) => {
      try {
        return slot.clip === clip;
      } catch {
        return false;
      }
    });
    if (index >= 0) {
      sceneIndex = index;
      break;
    }
  }

  const track = await song.createMidiTrack();
  context.withinTransaction(() => {
    track.name = `${clipName} bass`;
  });
  const slot = await slotOnNewTrack(track, sceneIndex);
  if (!slot) {
    await showDialog(context, renderErrorDialog("The new track reported no clip slots."), 420, 200);
    return;
  }
  console.log(`pytheory: creating bass clip (${generated.length} beats) at scene ${sceneIndex}`);
  await fillClip(context, slot, {
    ...generated,
    name: `${clipName} ${generated.name}`,
  });
}

async function transposeToKey(context: Context, handle: Handle) {
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

  if (!detected.tonic) {
    const fromSet = songKey(context, options);
    if (fromSet.source === "set") {
      detected.tonic = fromSet.tonic;
      detected.mode = fromSet.scale;
    }
  }

  const params = await showForm(
    context,
    renderTransposeForm(options, detected),
    440,
    320,
  );
  if (!params) return;

  const result = await analyze<{ notes: NoteDescription[]; changed: number }>(
    "transpose_to_key",
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
      "Transpose to Key",
      `Moved ${result.changed} ${result.changed === 1 ? "note" : "notes"} — now in ${params.targetTonic} ${params.targetScale}.`,
    ),
    420,
    200,
  );
}

async function smoothVoicings(context: Context, handle: Handle) {
  const clip = context.getObjectFromHandle(handle, MidiClip);
  const notes = clip.notes;
  if (notes.length === 0) {
    await showDialog(context, renderErrorDialog("This clip has no notes."), 420, 200);
    return;
  }

  const result = (await context.ui.withinProgressDialog(
    "Re-voicing…",
    {},
    () =>
      analyze<{ notes: NoteDescription[]; revoiced: number }>(
        "smooth_voicings",
        { notes },
      ),
  )) as { notes: NoteDescription[]; revoiced: number; error?: string };
  if (result.error) {
    await showDialog(context, renderErrorDialog(result.error), 420, 200);
    return;
  }

  if (result.revoiced === 0) {
    await showDialog(
      context,
      renderMessageDialog("Smooth Voicings", "Voicings already minimal — nothing to change."),
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
      "Smooth Voicings",
      `Re-voiced ${result.revoiced} ${result.revoiced === 1 ? "chord" : "chords"} for smoother voice leading.`,
    ),
    420,
    200,
  );
}

interface RenderedAudio {
  pcmBase64: string;
  sampleRate: number;
  channels: number;
}

async function renderAudio(context: Context, handle: Handle) {
  const clip = context.getObjectFromHandle(handle, MidiClip);
  const clipName = clip.name;
  const notes = clip.notes;
  if (notes.length === 0) {
    await showDialog(context, renderErrorDialog("This clip has no notes."), 420, 200);
    return;
  }

  const options = await analyze<Options>("get_options", null);
  const params = await showForm(context, renderRenderAudioForm(options), 440, 220);
  if (!params) return;

  const song = context.application.song;
  const instrument = String(params.instrument);

  await context.ui.withinProgressDialog(
    `Rendering with ${instrument}…`,
    {},
    async (update) => {
      const rendered = await analyze<RenderedAudio>("render_audio", {
        notes,
        instrument,
        bpm: song.tempo,
      });
      if (rendered.error) throw new Error(rendered.error);

      await update("Importing into project…", 80);
      const wavPath = path.join(
        writableDir(context),
        `pytheory-${instrument}-${Date.now()}.wav`,
      );
      writeWav(
        wavPath,
        Buffer.from(rendered.pcmBase64, "base64"),
        rendered.sampleRate,
        rendered.channels,
      );
      const imported = await context.resources.importIntoProject(wavPath);

      await update("Creating audio track…", 95);
      const track = await song.createAudioTrack();
      context.withinTransaction(() => {
        track.name = `${clipName} (${instrument})`;
      });
      const slot = await slotOnNewTrack(track, 0);
      if (!slot) {
        throw new Error(
          "The new audio track reported no clip slots — the rendered file " +
            `was imported to ${imported}.`,
        );
      }
      await slot.createAudioClip({ filePath: imported });
    },
  );
}

function writeWav(
  filePath: string,
  pcm: Buffer,
  sampleRate: number,
  channels: number,
) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28); // byte rate
  header.writeUInt16LE(channels * 2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  fs.writeFileSync(filePath, Buffer.concat([header, pcm]));
}

async function generateProgression(context: Context, handle: Handle) {
  const slot = context.getObjectFromHandle(handle, ClipSlot);
  if (!(await usableMidiSlot(context, slot))) return;

  const options = await analyze<Options>("get_options", null);
  const params = await showForm(
    context,
    renderProgressionForm(options, songKey(context, options)),
    460,
    360,
  );
  if (!params) return;

  if (params.progression === "symbols") {
    const generated = await analyze<GeneratedClip>("generate_from_symbols", {
      symbols: params.customSymbols,
      octave: params.octave,
      beatsPerChord: params.beatsPerChord,
    });
    if (generated.error) {
      await showDialog(context, renderErrorDialog(generated.error), 420, 200);
      return;
    }
    await fillClip(context, slot, generated);
    return;
  }

  const isRandom = params.progression === "random";
  const numerals = isRandom
    ? []
    : params.progression === "custom"
      ? String(params.customNumerals ?? "").trim().split(/[\s,-]+/)
      : options.progressions[String(params.progression)];

  const generated = await analyze<GeneratedClip>("generate_progression", {
    tonic: params.tonic,
    mode: params.mode,
    numerals,
    random: isRandom,
    length: 4,
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
  if (!(await usableMidiSlot(context, slot))) return;

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
  if (!(await usableMidiSlot(context, slot))) return;

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

/**
 * A slot we can generate into: empty, and on a MIDI track. Live's ClipSlot
 * context menu also appears on audio-track slots, where createMidiClip
 * fails with an opaque "Failed to create clip".
 */
async function usableMidiSlot(
  context: Context,
  slot: ClipSlot<typeof API_VERSION>,
): Promise<boolean> {
  let message: string | null = null;
  if (slot.clip) {
    message = "This clip slot already has a clip — pick an empty one.";
  } else {
    try {
      const parent = slot.parent;
      if (parent && !(parent instanceof MidiTrack)) {
        message = "This slot is on an audio track — MIDI clips need a MIDI track.";
      }
    } catch {
      // If the parent can't be resolved, let creation proceed and fail loudly.
    }
  }
  if (message) {
    await showDialog(context, renderErrorDialog(message), 420, 200);
    return false;
  }
  return true;
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
