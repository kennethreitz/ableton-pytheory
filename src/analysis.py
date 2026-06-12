"""Analysis helpers run inside Pyodide, bridging Live's MIDI notes to pytheory.

Each function takes a JSON payload string and returns a JSON string for the
extension to render. Clip notes are NoteDescription objects from the
Extensions SDK: pitch, startTime, duration, muted, ...
"""

import json

from pytheory import Chord, Key, Tone, TonedScale
from pytheory.scales import PROGRESSIONS
# Not the package-level Scale — pytheory/__init__ aliases that to TonedScale,
# which lacks the detect/recommend static methods.
from pytheory.scales import Scale

TONICS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
DEFAULT_VELOCITY = 100


def _note_names(pitches):
    """Unique pitch-class names, in order of first appearance."""
    return list(dict.fromkeys(Tone.from_midi(p).name for p in pitches))


def _scale_names():
    return [s for s in TonedScale(tonic="C4").scales if s != "chromatic"]


def _chord_label(chord):
    return chord.symbol or chord.identify()


def get_options(_payload=None):
    """Choices for the generator dialogs."""
    return json.dumps({
        "tonics": TONICS,
        "scales": _scale_names(),
        "progressions": {
            name: list(numerals) for name, numerals in PROGRESSIONS.items()
        },
    })


def detect_key(notes_json):
    notes = json.loads(notes_json)
    pitches = [n["pitch"] for n in notes if not n.get("muted")]
    if not pitches:
        return json.dumps({"error": "This clip has no unmuted notes."})

    names = _note_names(pitches)
    key = Key.detect(*names)
    recommendations = Scale.recommend(*names, top=5)

    return json.dumps({
        "key": str(key) if key else None,
        "tonic": key.tonic_name if key else None,
        "mode": key.mode if key else None,
        "noteNames": names,
        "noteCount": len(pitches),
        "recommendations": [
            {"tonic": tonic, "scale": scale, "fitness": round(fitness, 3)}
            for tonic, scale, fitness in recommendations
        ],
    })


def _cluster_chords(notes):
    """Cluster notes by onset so slightly humanized chords group together."""
    notes = sorted(notes, key=lambda n: n["startTime"])
    clusters = []
    for note in notes:
        if clusters and note["startTime"] - clusters[-1]["start"] <= 0.125:
            clusters[-1]["notes"].append(note)
        else:
            clusters.append({"start": note["startTime"], "notes": [note]})
    return clusters


def detect_chords(notes_json):
    notes = [n for n in json.loads(notes_json) if not n.get("muted")]
    if not notes:
        return json.dumps({"error": "This clip has no unmuted notes."})

    key = Key.detect(*_note_names(n["pitch"] for n in notes))

    chords = []
    for cluster in _cluster_chords(notes):
        pitches = sorted({n["pitch"] for n in cluster["notes"]})
        if len({p % 12 for p in pitches}) < 2:
            continue  # single pitch class — not a chord
        tones = [Tone.from_midi(p) for p in pitches]
        chord = Chord(tones)
        numeral = None
        if key:
            try:
                numeral = chord.analyze(key.tonic_name, key.mode)
            except (KeyError, ValueError):
                pass
        chords.append({
            "start": cluster["start"],
            "notes": [str(t) for t in tones],
            "name": chord.identify(),
            "symbol": _chord_label(chord),
            "numeral": numeral,
        })

    if not chords:
        return json.dumps({
            "error": "No chords found — the clip looks monophonic."
        })
    return json.dumps({"chords": chords, "key": str(key) if key else None})


def generate_progression(payload_json):
    params = json.loads(payload_json)
    tonic = params["tonic"]
    mode = params["mode"]
    numerals = [n for n in params["numerals"] if n]
    octave = int(params.get("octave", 4))
    beats = float(params.get("beatsPerChord", 4))

    if not numerals:
        return json.dumps({"error": "No chords in the progression."})

    # pytheory wraps out-of-range numerals around the scale silently —
    # reject anything that isn't a degree I–VII (with b/# and 7 modifiers).
    valid = {"I", "II", "III", "IV", "V", "VI", "VII"}
    for numeral in numerals:
        base = numeral.rstrip("7").lstrip("b#").upper()
        if base not in valid:
            return json.dumps({"error": f"'{numeral}' isn't a Roman numeral I–VII."})

    try:
        key = Key(tonic, mode)
        chords = key.progression(*numerals)
    except (KeyError, ValueError, IndexError) as e:
        return json.dumps({
            "error": f"Couldn't build {'-'.join(numerals)} in {tonic} {mode}: {e}"
        })

    shift = (octave - 4) * 12
    notes = []
    labels = []
    for i, chord in enumerate(chords):
        labels.append(_chord_label(chord) or numerals[i])
        for tone in chord.tones:
            pitch = tone.midi + shift
            if 0 <= pitch <= 127:
                notes.append({
                    "pitch": pitch,
                    "startTime": i * beats,
                    "duration": beats,
                    "velocity": DEFAULT_VELOCITY,
                })

    return json.dumps({
        "notes": notes,
        "length": len(chords) * beats,
        "name": f"{tonic} {mode}: {'-'.join(numerals)}",
        "chordNames": labels,
    })


def generate_scale(payload_json):
    params = json.loads(payload_json)
    tonic = params["tonic"]
    scale_name = params["scale"]
    octave = int(params.get("octave", 4))
    duration = float(params.get("noteDuration", 0.5))
    descend = bool(params.get("descend"))

    try:
        scale = TonedScale(tonic=f"{tonic}{octave}")[scale_name]
    except (KeyError, ValueError) as e:
        return json.dumps({"error": f"Couldn't build {tonic} {scale_name}: {e}"})

    pitches = [t.midi for t in scale.tones]
    if descend:
        pitches = pitches + pitches[-2::-1]  # up, then back down

    notes = [
        {
            "pitch": pitch,
            "startTime": i * duration,
            "duration": duration,
            "velocity": DEFAULT_VELOCITY,
        }
        for i, pitch in enumerate(pitches)
        if 0 <= pitch <= 127
    ]
    return json.dumps({
        "notes": notes,
        "length": len(pitches) * duration,
        "name": f"{tonic} {scale_name} scale",
    })


def conform_to_scale(payload_json):
    params = json.loads(payload_json)
    notes = params["notes"]
    tonic = params["tonic"]
    scale_name = params["scale"]

    try:
        scale = TonedScale(tonic=f"{tonic}4")[scale_name]
    except (KeyError, ValueError) as e:
        return json.dumps({"error": f"Unknown scale {tonic} {scale_name}: {e}"})

    scale_pcs = sorted({t.midi % 12 for t in scale.tones})

    def snap(pitch):
        pc = pitch % 12
        if pc in scale_pcs:
            return pitch
        # Nearest scale pitch class; ties resolve downward.
        best = min(
            scale_pcs,
            key=lambda s: (min((pc - s) % 12, (s - pc) % 12), (pc - s) % 12),
        )
        delta = (best - pc) % 12
        if delta > 6:
            delta -= 12
        return min(127, max(0, pitch + delta))

    changed = 0
    conformed = []
    for note in notes:
        new = dict(note)
        if not note.get("muted"):
            snapped = snap(note["pitch"])
            if snapped != note["pitch"]:
                new["pitch"] = snapped
                changed += 1
        conformed.append(new)

    return json.dumps({"notes": conformed, "changed": changed})
