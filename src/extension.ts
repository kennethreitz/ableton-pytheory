import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import {
  initialize,
  AudioClip,
  AudioTrack,
  ClipSlot,
  DataModelObject,
  MidiClip,
  MidiTrack,
  Sample,
  Scene,
  Simpler,
  type ActivationContext,
  type ExtensionContext,
  type Handle,
  type NoteDescription,
} from "@ableton-extensions/sdk";

import { analyze, getPython } from "./python.js";
import {
  renderArpeggiateForm,
  renderAudioDetectDialog,
  renderAudioToMidiForm,
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
  renderSamplePitchDialog,
  renderScaleForm,
  renderSceneKeyDialog,
  renderSketchForm,
  renderSubstitutionsDialog,
  renderSuggestionsDialog,
  renderTabsDialog,
  renderTabsForm,
  renderTransposeForm,
  type AudioDetectResult,
  type ChordsResult,
  type KeyDefaults,
  type KeyResult,
  type MelodyAnalysis,
  type NotationResult,
  type Options,
  type SamplePitchResult,
  type SceneKeyResult,
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
    ["MidiClip", "Invert Melody", "pytheory.invert", invertMelody],
    ["MidiClip", "Retrograde", "pytheory.retrograde", retrogradeClip],
    ["MidiClip", "Render to Audio…", "pytheory.render-audio", renderAudio],
    ["ClipSlot", "Generate Progression…", "pytheory.generate-progression", generateProgression],
    ["ClipSlot", "Generate Scale…", "pytheory.generate-scale", generateScale],
    ["ClipSlot", "Generate Drum Pattern…", "pytheory.generate-drums", generateDrums],
    ["ClipSlot", "Generate Melody…", "pytheory.generate-melody", generateMelody],
  ];
  const sceneCommands: [label: string, id: string,
    run: (context: Context, handle: Handle) => Promise<void>][] = [
    ["Generate Song Sketch…", "pytheory.sketch", generateSketch],
  ];
  const audioCommands: [label: string, id: string,
    run: (context: Context, handle: Handle) => Promise<void>][] = [
    ["Detect Key & Chords", "pytheory.audio-detect", audioDetect],
    ["Convert to MIDI…", "pytheory.audio-to-midi", audioToMidi],
  ];

  const register = (
    scope: "MidiClip" | "ClipSlot" | "Scene" | "AudioClip" | "Sample" | "Simpler",
    label: string,
    id: string,
    run: (context: Context, handle: Handle) => Promise<void>,
  ) => {
    context.commands.registerCommand(id, (handle) => {
      run(context, handle as Handle).catch(async (error) => {
        console.error(`pytheory: ${id} failed:`, error);
        await showDialog(context, renderErrorDialog(String(error)), 420, 220);
      });
    });
    context.ui.registerContextMenuAction(scope, label, id);
  };
  for (const [scope, label, id, run] of commands) register(scope, label, id, run);
  for (const [label, id, run] of sceneCommands) register("Scene", label, id, run);
  for (const [label, id, run] of audioCommands) register("AudioClip", label, id, run);
  register("Scene", "Detect Scene Key", "pytheory.scene-key", detectSceneKey);
  register("Sample", "Tune to Set Key", "pytheory.tune-sample", tuneSample);
  register("Simpler", "Tune to Set Key", "pytheory.tune-simpler", tuneSample);

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

async function applyTransform(
  context: Context,
  handle: Handle,
  fn: "invert_notes" | "retrograde_notes",
  title: string,
  describe: (changed: number) => string,
) {
  const clip = context.getObjectFromHandle(handle, MidiClip);
  const notes = clip.notes;
  if (notes.length === 0) {
    await showDialog(context, renderErrorDialog("This clip has no notes."), 420, 200);
    return;
  }
  const result = await analyze<{ notes: NoteDescription[]; changed: number }>(
    fn,
    { notes },
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
    renderMessageDialog(title, describe(result.changed)),
    420,
    200,
  );
}

function invertMelody(context: Context, handle: Handle) {
  return applyTransform(
    context,
    handle,
    "invert_notes",
    "Invert Melody",
    (changed) =>
      `Mirrored ${changed} ${changed === 1 ? "note" : "notes"} around the first note (diatonically where in key). Run again to undo musically.`,
  );
}

function retrogradeClip(context: Context, handle: Handle) {
  return applyTransform(
    context,
    handle,
    "retrograde_notes",
    "Retrograde",
    () => "Reversed the clip in time. Run again to restore the original order.",
  );
}

interface SketchResult {
  name: string;
  key: string;
  parts: Record<"chords" | "bass" | "melody" | "drums", GeneratedClip>;
}

async function generateSketch(context: Context, handle: Handle) {
  const scene = context.getObjectFromHandle(handle, Scene);
  const song = context.application.song;
  const sceneIndex = Math.max(
    0,
    song.scenes.findIndex((s) => s === scene),
  );

  const options = await analyze<Options>("get_options", null);
  const params = await showForm(
    context,
    renderSketchForm(options, songKey(context, options)),
    480,
    320,
  );
  if (!params) return;

  const sketch = (await context.ui.withinProgressDialog(
    "Sketching…",
    {},
    () => analyze<SketchResult>("generate_sketch", params),
  )) as SketchResult & { error?: string };
  if (sketch.error) {
    await showDialog(context, renderErrorDialog(sketch.error), 420, 200);
    return;
  }

  await context.ui.withinProgressDialog(
    `Building tracks for ${sketch.name}…`,
    {},
    async (update) => {
      const order = ["chords", "bass", "melody", "drums"] as const;
      for (let i = 0; i < order.length; i++) {
        const partName = order[i];
        await update(`Creating ${partName} track…`, (i / order.length) * 100);
        const track = await song.createMidiTrack();
        context.withinTransaction(() => {
          track.name = `${sketch.key} ${partName}`;
        });
        const slot = await slotOnNewTrack(track, sceneIndex);
        if (!slot) throw new Error(`The new ${partName} track reported no clip slots.`);
        await fillClip(context, slot, sketch.parts[partName]);
      }
    },
  );
}

interface TranscriptionResult {
  parts: Record<string, GeneratedClip>;
  bpm: number;
}

/**
 * A WAV to analyze for an audio clip: the clip's own file when it's a WAV,
 * otherwise a pre-FX render of its arrangement region. Shows an error
 * dialog and returns null when neither is possible.
 */
async function wavForAudioClip(
  context: Context,
  clip: AudioClip<typeof API_VERSION>,
): Promise<string | null> {
  const filePath = clip.filePath;
  if (/\.wav$/i.test(filePath)) return filePath;
  const parent = clip.parent;
  if (parent instanceof AudioTrack && clip.endTime > clip.startTime) {
    return (await context.ui.withinProgressDialog(
      "Rendering audio…",
      {},
      () =>
        context.resources.renderPreFxAudio(
          parent,
          clip.startTime,
          clip.endTime,
        ),
    )) as string;
  }
  await showDialog(
    context,
    renderErrorDialog(
      "Only WAV files can be analyzed directly. For other formats, place the clip in the Arrangement so its audio can be rendered first.",
    ),
    460,
    220,
  );
  return null;
}

async function audioDetect(context: Context, handle: Handle) {
  const clip = context.getObjectFromHandle(handle, AudioClip);
  const clipName = clip.name;
  const wavPath = await wavForAudioClip(context, clip);
  if (!wavPath) return;

  const result = (await context.ui.withinProgressDialog(
    "Listening…",
    {},
    () =>
      analyze<AudioDetectResult>("audio_detect", {
        hostPath: wavPath,
        bpm: context.application.song.tempo,
      }),
  )) as AudioDetectResult & { error?: string };
  if (result.error) {
    await showDialog(context, renderErrorDialog(result.error), 460, 220);
    return;
  }
  await showDialog(context, renderAudioDetectDialog(clipName, result), 480, 420);
}

async function tuneSample(context: Context, handle: Handle) {
  const target = context.getObjectFromHandle(handle, DataModelObject);
  const sample =
    target instanceof Simpler
      ? target.sample
      : target instanceof Sample
        ? target
        : null;
  if (!sample) {
    await showDialog(context, renderErrorDialog("No sample loaded here."), 420, 200);
    return;
  }

  const filePath = sample.filePath;
  if (!/\.wav$/i.test(filePath)) {
    await showDialog(
      context,
      renderErrorDialog("Only WAV samples can be pitch-analyzed for now."),
      440,
      200,
    );
    return;
  }

  const setTonic = TONICS[context.application.song.rootNote] ?? null;
  const result = (await context.ui.withinProgressDialog(
    "Listening…",
    {},
    () =>
      analyze<SamplePitchResult>("sample_pitch", {
        hostPath: filePath,
        setTonic,
      }),
  )) as SamplePitchResult & { error?: string };
  if (result.error) {
    await showDialog(context, renderErrorDialog(result.error), 440, 200);
    return;
  }
  await showDialog(
    context,
    renderSamplePitchDialog(path.basename(filePath), result),
    460,
    240,
  );
}

async function detectSceneKey(context: Context, handle: Handle) {
  const scene = context.getObjectFromHandle(handle, Scene);
  const song = context.application.song;
  const sceneIndex = song.scenes.findIndex((s) => s === scene);
  if (sceneIndex < 0) {
    await showDialog(context, renderErrorDialog("Couldn't locate this scene."), 420, 200);
    return;
  }

  const clips: { name: string; notes: NoteDescription[] }[] = [];
  for (const track of song.tracks) {
    try {
      const clip = track.clipSlots[sceneIndex]?.clip;
      if (clip instanceof MidiClip) {
        clips.push({ name: clip.name, notes: clip.notes });
      }
    } catch {
      // skip slots that can't be read
    }
  }
  if (clips.length === 0) {
    await showDialog(
      context,
      renderErrorDialog("No MIDI clips in this scene."),
      420,
      200,
    );
    return;
  }

  const result = (await context.ui.withinProgressDialog(
    "Analyzing scene…",
    {},
    () => analyze<SceneKeyResult>("scene_key", { clips }),
  )) as SceneKeyResult & { error?: string };
  if (result.error) {
    await showDialog(context, renderErrorDialog(result.error), 420, 200);
    return;
  }

  const sceneName = scene.name || `Scene ${sceneIndex + 1}`;
  await showDialog(context, renderSceneKeyDialog(sceneName, result), 460, 380);
}

async function audioToMidi(context: Context, handle: Handle) {
  const clip = context.getObjectFromHandle(handle, AudioClip);
  const clipName = clip.name;
  const song = context.application.song;
  const wavPath = await wavForAudioClip(context, clip);
  if (!wavPath) return;

  const params = await showForm(context, renderAudioToMidiForm(), 460, 260);
  if (!params) return;

  const result = (await context.ui.withinProgressDialog(
    "Transcribing audio…",
    {},
    () =>
      analyze<TranscriptionResult>("audio_to_midi", {
        hostPath: wavPath,
        bpm: song.tempo,
        quantize: params.quantize || null,
        split: Boolean(params.split),
      }),
  )) as TranscriptionResult & { error?: string };
  if (result.error) {
    await showDialog(context, renderErrorDialog(result.error), 460, 220);
    return;
  }

  // Place each transcribed part on a new MIDI track, at the source
  // clip's scene when it lives in the Session grid.
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

  for (const [partName, part] of Object.entries(result.parts)) {
    const track = await song.createMidiTrack();
    context.withinTransaction(() => {
      track.name = `${clipName} ${partName} (MIDI)`;
    });
    const slot = await slotOnNewTrack(track, sceneIndex);
    if (!slot) throw new Error(`The new ${partName} track reported no clip slots.`);
    await fillClip(context, slot, {
      ...part,
      name: `${clipName} ${partName}`,
    });
  }
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
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
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
