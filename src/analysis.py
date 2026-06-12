"""Analysis helpers run inside Pyodide, bridging Live's MIDI notes to pytheory.

Each function takes a JSON payload string and returns a JSON string for the
extension to render. Clip notes are NoteDescription objects from the
Extensions SDK: pitch, startTime, duration, muted, ...
"""

import base64
import json
import random

from pytheory import Chord, Fretboard, Key, Tone, TonedScale, render_score
from pytheory.rhythm import INSTRUMENTS, Pattern, Score, _RawDuration
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
        "drumPatterns": Pattern.list_presets(),
        "drumFills": Pattern.list_fills(),
        "instruments": list(INSTRUMENTS),
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


def _random_numerals(length):
    """Random walk through the transition graph mined from PROGRESSIONS."""
    rng = random.Random()
    transitions = _transitions()
    current = rng.choice(["I", "I", "i", "vi", "IV"])  # weighted toward home
    sequence = [current]
    for _ in range(length - 1):
        choices = transitions.get(current)
        if choices:
            current = rng.choices(
                list(choices), weights=list(choices.values())
            )[0]
        else:
            current = rng.choice(["I", "IV", "V", "vi", "ii"])
        sequence.append(current)
    return sequence


def generate_progression(payload_json):
    params = json.loads(payload_json)
    tonic = params["tonic"]
    mode = params["mode"]
    octave = int(params.get("octave", 4))
    beats = float(params.get("beatsPerChord", 4))
    if params.get("random"):
        numerals = _random_numerals(int(params.get("length", 4)))
    else:
        numerals = [n for n in params["numerals"] if n]

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


# Chord chart names use flats.
_FLATS = {"C#": "Db", "D#": "Eb", "F#": "Gb", "G#": "Ab", "A#": "Bb"}

# Map Chord.identify() qualities to the chart's chord-name vocabulary.
_CHART_QUALITIES = {
    "major": "",
    "minor": "m",
    "power": "5",
    "diminished": "dim",
    "dominant 7th": "7",
    "major 7th": "maj7",
    "minor 7th": "m7",
    "dominant 9th": "9",
    "major 9th": "maj9",
    "minor 9th": "m9",
}

_FRETBOARDS = ["guitar", "ukulele", "bass", "mandolin", "banjo"]


def guitar_tabs(payload_json):
    params = json.loads(payload_json)
    notes = [n for n in params["notes"] if not n.get("muted")]
    instrument = params.get("instrument", "guitar")
    if instrument not in _FRETBOARDS:
        return json.dumps({"error": f"Unknown instrument: {instrument}"})
    if not notes:
        return json.dumps({"error": "This clip has no unmuted notes."})

    fretboard = getattr(Fretboard, instrument)()

    # Unique chords, in order of first appearance, with the bars they hit.
    found = {}
    for cluster in _cluster_chords(notes):
        pitches = sorted({n["pitch"] for n in cluster["notes"]})
        if len({p % 12 for p in pitches}) < 2:
            continue
        chord = Chord([Tone.from_midi(p) for p in pitches])
        identified = chord.identify()
        if not identified:
            continue
        symbol = _chord_label(chord)
        bar = int(cluster["start"] // 4) + 1
        if symbol in found:
            if bar not in found[symbol]["bars"]:
                found[symbol]["bars"].append(bar)
            continue

        root, _, quality = identified.partition(" ")
        suffix = _CHART_QUALITIES.get(quality)
        tab = None
        if suffix is not None:
            chart_name = _FLATS.get(root, root) + suffix
            try:
                tab = fretboard.chord(chart_name).tab()
                # Drop the chord-name header — the dialog renders its own.
                if "\n" in tab:
                    tab = tab.split("\n", 1)[1]
            except (KeyError, ValueError):
                pass
        found[symbol] = {"symbol": symbol, "tab": tab, "bars": [bar]}

    key = Key.detect(*_note_names(n["pitch"] for n in notes))

    # Fretboard map of the detected key's scale — this also makes tabs
    # useful for melodic (chord-free) clips.
    diagram = None
    if key:
        try:
            scale = TonedScale(tonic=f"{key.tonic_name}4")[key.mode]
            diagram = fretboard.scale_diagram(scale, frets=12)
        except (KeyError, ValueError):
            pass

    if not found and not diagram:
        return json.dumps({
            "error": "No chords found, and no key detected for a scale map."
        })
    return json.dumps({
        "instrument": instrument,
        "key": str(key) if key else None,
        "scaleDiagram": diagram,
        "chords": list(found.values()),
    })


def generate_drums(payload_json):
    params = json.loads(payload_json)
    pattern_name = params["pattern"]
    repeats = int(params.get("repeats", 4))
    fill_name = params.get("fill") or None

    try:
        pattern = Pattern.preset(pattern_name)
        fill = Pattern.fill(fill_name) if fill_name else None
    except (KeyError, ValueError) as e:
        return json.dumps({"error": f"Unknown pattern: {e}"})

    # The fill replaces the last cycle of the pattern.
    cycles = [pattern] * repeats
    if fill:
        cycles[-1] = fill

    notes = []
    offset = 0.0
    for cycle in cycles:
        for hit in cycle.hits:
            notes.append({
                "pitch": hit.sound.value,  # General MIDI drum map
                "startTime": offset + hit.position,
                "duration": 0.25,
                "velocity": hit.velocity,
            })
        offset += cycle.beats

    name = f"{pattern_name} beat"
    if fill_name:
        name += f" + {fill_name} fill"
    return json.dumps({"notes": notes, "length": offset, "name": name})


def _scale_degrees(tonic, scale_name):
    """Pitch classes of the scale, in degree order starting at the tonic."""
    scale = TonedScale(tonic=f"{tonic}4")[scale_name]
    degrees = []
    for tone in scale.tones:
        pc = tone.midi % 12
        if pc not in degrees:
            degrees.append(pc)
    return degrees


def harmonize(payload_json):
    params = json.loads(payload_json)
    notes = params["notes"]
    tonic = params["tonic"]
    scale_name = params["scale"]
    interval = params.get("interval", "third")
    below = params.get("direction", "above") == "below"

    try:
        degrees = _scale_degrees(tonic, scale_name)
    except (KeyError, ValueError) as e:
        return json.dumps({"error": f"Unknown scale {tonic} {scale_name}: {e}"})

    steps = {"third": [2], "sixth": [5], "triad": [2, 4], "octave": []}
    if interval not in steps:
        return json.dumps({"error": f"Unknown interval: {interval}"})

    def voice(pitch, step):
        """Diatonic step above/below pitch, staying in the scale."""
        pc = pitch % 12
        if pc not in degrees:
            return None  # note is outside the scale — leave it alone
        index = degrees.index(pc)
        target = degrees[(index - step if below else index + step) % len(degrees)]
        if below:
            return pitch - ((pc - target) % 12 or 12)
        return pitch + ((target - pc) % 12 or 12)

    existing = {(n["pitch"], n["startTime"]) for n in notes}
    added = []
    for note in notes:
        if note.get("muted"):
            continue
        pitches = (
            [note["pitch"] + (-12 if below else 12)]
            if interval == "octave"
            else [voice(note["pitch"], s) for s in steps[interval]]
        )
        for pitch in pitches:
            if pitch is None or not 0 <= pitch <= 127:
                continue
            if (pitch, note["startTime"]) in existing:
                continue
            existing.add((pitch, note["startTime"]))
            harmony = dict(note)
            harmony["pitch"] = pitch
            harmony["velocity"] = max(1, int(note.get("velocity", 100) * 0.9))
            added.append(harmony)

    if not added:
        return json.dumps({
            "error": "Nothing to harmonize — no unmuted notes in the scale."
        })
    return json.dumps({"notes": notes + added, "added": len(added)})


def arpeggiate(payload_json):
    params = json.loads(payload_json)
    notes = [n for n in params["notes"] if not n.get("muted")]
    rate = float(params.get("rate", 0.25))
    style = params.get("style", "up")

    result = []
    arpeggiated = 0
    for cluster in _cluster_chords(notes):
        pitches = sorted({n["pitch"] for n in cluster["notes"]})
        if len(pitches) < 2:
            result.extend(cluster["notes"])
            continue

        if style == "down":
            sequence = list(reversed(pitches))
        elif style == "updown":
            sequence = pitches + pitches[-2:0:-1]
        else:
            sequence = pitches

        arpeggiated += 1
        start = cluster["start"]
        end = max(n["startTime"] + n["duration"] for n in cluster["notes"])
        velocity = max(
            (n.get("velocity", 100) for n in cluster["notes"]), default=100
        )
        i = 0
        t = start
        while t < end - 1e-9:
            result.append({
                "pitch": sequence[i % len(sequence)],
                "startTime": t,
                "duration": min(rate, end - t),
                "velocity": velocity,
            })
            i += 1
            t = start + i * rate

    if not arpeggiated:
        return json.dumps({
            "error": "No chords to arpeggiate — the clip looks monophonic."
        })
    return json.dumps({"notes": result, "arpeggiated": arpeggiated})


def _transitions():
    """Chord-to-chord transition counts mined from the progression corpus."""
    counts = {}
    for numerals in PROGRESSIONS.values():
        pairs = list(zip(numerals, numerals[1:])) + [(numerals[-1], numerals[0])]
        for a, b in pairs:
            counts.setdefault(a, {})
            counts[a][b] = counts[a].get(b, 0) + 1
    return counts


def _chord_for_numeral(key, numeral):
    try:
        chord = key.progression(numeral)[0]
        return _chord_label(chord), [str(t) for t in chord.tones]
    except (KeyError, ValueError, IndexError):
        return None, []


def suggest_next_chord(notes_json):
    notes = [n for n in json.loads(notes_json) if not n.get("muted")]
    if not notes:
        return json.dumps({"error": "This clip has no unmuted notes."})

    key = Key.detect(*_note_names(n["pitch"] for n in notes))
    if not key:
        return json.dumps({"error": "Couldn't detect a key for this clip."})

    clusters = [
        c for c in _cluster_chords(notes)
        if len({n["pitch"] % 12 for n in c["notes"]}) >= 2
    ]
    if not clusters:
        return json.dumps({"error": "No chords found to continue from."})

    last = Chord([
        Tone.from_midi(p)
        for p in sorted({n["pitch"] for n in clusters[-1]["notes"]})
    ])
    numeral = last.analyze(key.tonic_name, key.mode)
    if not numeral:
        return json.dumps({
            "error": f"The last chord ({_chord_label(last)}) doesn't fit "
                     f"{key}, so I can't suggest a continuation."
        })

    ranked = sorted(
        _transitions().get(numeral, {}).items(), key=lambda kv: -kv[1]
    )
    if not ranked:  # no corpus data — fall back to the pillars of the key
        ranked = [("I", 0), ("IV", 0), ("V", 0), ("vi", 0)]

    suggestions = []
    for next_numeral, count in ranked[:6]:
        symbol, tones = _chord_for_numeral(key, next_numeral)
        if symbol:
            suggestions.append({
                "numeral": next_numeral,
                "symbol": symbol,
                "notes": tones,
                "count": count,
            })

    return json.dumps({
        "key": str(key),
        "lastChord": {"symbol": _chord_label(last), "numeral": numeral},
        "suggestions": suggestions,
    })


def chord_substitutions(notes_json):
    notes = [n for n in json.loads(notes_json) if not n.get("muted")]
    if not notes:
        return json.dumps({"error": "This clip has no unmuted notes."})

    key = Key.detect(*_note_names(n["pitch"] for n in notes))

    def describe(root_pc, quality_pcs, label):
        root_name = TONICS[root_pc % 12]
        chord = Chord([Tone.from_midi(60 + ((root_pc + i) % 12)) for i in quality_pcs])
        symbol = _chord_label(chord)
        return {"symbol": symbol or root_name, "reason": label}

    MAJOR = [0, 4, 7]
    MINOR = [0, 3, 7]
    DOM7 = [0, 4, 7, 10]

    found = {}
    for cluster in _cluster_chords(notes):
        pitches = sorted({n["pitch"] for n in cluster["notes"]})
        if len({p % 12 for p in pitches}) < 2:
            continue
        chord = Chord([Tone.from_midi(p) for p in pitches])
        identified = chord.identify()
        symbol = _chord_label(chord)
        if not identified or symbol in found:
            continue

        root_name, _, quality = identified.partition(" ")
        root_pc = TONICS.index(_FLATS_REVERSED.get(root_name, root_name)) \
            if root_name in TONICS or root_name in _FLATS_REVERSED else None
        if root_pc is None:
            continue

        subs = []
        if quality == "major":
            subs.append(describe((root_pc + 9) % 12, MINOR, "relative minor"))
            subs.append(describe(root_pc, MINOR, "parallel minor (borrowed)"))
        elif quality == "minor":
            subs.append(describe((root_pc + 3) % 12, MAJOR, "relative major"))
            subs.append(describe(root_pc, MAJOR, "parallel major (borrowed)"))
        if quality in ("dominant 7th", "major", "minor"):
            subs.append(describe((root_pc + 6) % 12, DOM7, "tritone substitution"))
        subs.append(describe((root_pc + 7) % 12, DOM7, "secondary dominant (V7 of this)"))

        found[symbol] = {"symbol": symbol, "substitutions": subs}

    if not found:
        return json.dumps({"error": "No chords found in this clip."})
    return json.dumps({
        "key": str(key) if key else None,
        "chords": list(found.values()),
    })


_FLATS_REVERSED = {"Db": "C#", "Eb": "D#", "Gb": "F#", "Ab": "G#", "Bb": "A#"}


def analyze_melody(notes_json):
    notes = [n for n in json.loads(notes_json) if not n.get("muted")]
    if not notes:
        return json.dumps({"error": "This clip has no unmuted notes."})

    key = Key.detect(*_note_names(n["pitch"] for n in notes))
    if not key:
        return json.dumps({"error": "Couldn't detect a key for this clip."})
    degrees = _scale_degrees(key.tonic_name, key.mode)

    def degree_label(pc):
        if pc in degrees:
            return str(degrees.index(pc) + 1)
        if (pc - 1) % 12 in degrees:
            return "#" + str(degrees.index((pc - 1) % 12) + 1)
        if (pc + 1) % 12 in degrees:
            return "b" + str(degrees.index((pc + 1) % 12) + 1)
        return "?"

    notes.sort(key=lambda n: (n["startTime"], n["pitch"]))
    rows = []
    histogram = {}
    in_scale = 0
    for note in notes:
        pc = note["pitch"] % 12
        label = degree_label(pc)
        if pc in degrees:
            in_scale += 1
        histogram[label] = histogram.get(label, 0) + 1
        rows.append({
            "name": str(Tone.from_midi(note["pitch"])),
            "degree": label,
            "start": note["startTime"],
        })

    pitches = [n["pitch"] for n in notes]
    return json.dumps({
        "key": str(key),
        "noteCount": len(notes),
        "inScalePercent": round(100 * in_scale / len(notes)),
        "low": str(Tone.from_midi(min(pitches))),
        "high": str(Tone.from_midi(max(pitches))),
        "histogram": sorted(histogram.items(), key=lambda kv: -kv[1]),
        "rows": rows[:120],
        "truncated": max(0, len(rows) - 120),
    })


def negative_harmony(payload_json):
    """Mirror notes around the key's tonic–dominant axis."""
    params = json.loads(payload_json)
    notes = params["notes"]
    tonic_pc = TONICS.index(params["tonic"])

    changed = 0
    mirrored = []
    for note in notes:
        new = dict(note)
        if not note.get("muted"):
            pitch = note["pitch"]
            target_pc = (2 * tonic_pc + 7 - pitch) % 12
            # Nearest octave placement to the original pitch (ties go down).
            delta = (target_pc - pitch % 12 + 6) % 12 - 6
            new_pitch = min(127, max(0, pitch + delta))
            if new_pitch != pitch:
                new["pitch"] = new_pitch
                changed += 1
        mirrored.append(new)

    return json.dumps({"notes": mirrored, "changed": changed})


def generate_melody(payload_json):
    params = json.loads(payload_json)
    tonic = params["tonic"]
    scale_name = params["scale"]
    octave = int(params.get("octave", 4))
    bars = int(params.get("bars", 4))
    density = params.get("density", "medium")

    try:
        scale = TonedScale(tonic=f"{tonic}{octave}")[scale_name]
    except (KeyError, ValueError) as e:
        return json.dumps({"error": f"Couldn't build {tonic} {scale_name}: {e}"})

    # Two octaves of scale tones to walk around in.
    base = [t.midi for t in scale.tones][:-1]
    pool = base + [p + 12 for p in base] + [base[0] + 24]

    durations = {
        "sparse": [(1.0, 5), (2.0, 3), (0.5, 2)],
        "medium": [(0.5, 5), (1.0, 3), (0.25, 2)],
        "busy": [(0.25, 5), (0.5, 4), (0.125, 1)],
    }.get(density)
    if not durations:
        return json.dumps({"error": f"Unknown density: {density}"})

    rng = random.Random()
    total = bars * 4.0
    # Start on the tonic, third, or fifth in the middle octave.
    index = len(base) + rng.choice([0, 2, 4])
    position = 0.0
    notes = []
    while position < total - 1e-9:
        duration = rng.choices(
            [d for d, _ in durations], [w for _, w in durations]
        )[0]
        duration = min(duration, total - position)
        if rng.random() < 0.12 and notes:  # breathe occasionally
            position += duration
            continue
        # Mostly stepwise motion, occasional leaps, pulled toward the middle.
        step = rng.choices([-2, -1, 1, 2, 3, -3], [2, 8, 8, 2, 1, 1])[0]
        if index + step < 0 or index + step >= len(pool):
            step = -step
        index = min(len(pool) - 1, max(0, index + step))
        notes.append({
            "pitch": pool[index],
            "startTime": position,
            "duration": duration,
            "velocity": rng.randint(84, 110),
        })
        position += duration

    # Resolve home: end on the tonic nearest the last note.
    if notes:
        last = notes[-1]
        tonic_options = [p for p in pool if p % 12 == base[0] % 12]
        last["pitch"] = min(tonic_options, key=lambda p: abs(p - last["pitch"]))

    return json.dumps({
        "notes": notes,
        "length": total,
        "name": f"{tonic} {scale_name} melody",
    })


def transpose_to_key(payload_json):
    """Scale-degree-aware transposition (C major -> C minor moves E to Eb)."""
    params = json.loads(payload_json)
    notes = params["notes"]

    try:
        src = _scale_degrees(params["sourceTonic"], params["sourceScale"])
        tgt = _scale_degrees(params["targetTonic"], params["targetScale"])
    except (KeyError, ValueError) as e:
        return json.dumps({"error": f"Unknown scale: {e}"})
    if len(src) != len(tgt):
        return json.dumps({
            "error": "Source and target scales have different numbers of degrees."
        })

    # Shortest chromatic move between the two tonics.
    shift = ((tgt[0] - src[0] + 6) % 12) - 6

    changed = 0
    transposed = []
    for note in notes:
        new = dict(note)
        if not note.get("muted"):
            pitch = note["pitch"]
            pc = pitch % 12
            if pc in src:
                index = src.index(pc)
                rel_src = (pc - src[0]) % 12
                rel_tgt = (tgt[index] - tgt[0]) % 12
                new_pitch = pitch + shift + (rel_tgt - rel_src)
            else:
                new_pitch = pitch + shift  # chromatic passing note
            new_pitch = min(127, max(0, new_pitch))
            if new_pitch != pitch:
                new["pitch"] = new_pitch
                changed += 1
        transposed.append(new)

    return json.dumps({"notes": transposed, "changed": changed})


def _voicing_candidates(pitches):
    """Inversions of a chord, each at three octaves."""
    base = sorted(pitches)
    shapes = [list(base)]
    up = list(base)
    down = list(base)
    for _ in range(len(base) - 1):
        up = sorted(up[1:] + [up[0] + 12])
        down = sorted([down[-1] - 12] + down[:-1])
        shapes.append(list(up))
        shapes.append(list(down))
    return [
        [p + octave for p in shape]
        for shape in shapes
        for octave in (-12, 0, 12)
    ]


def smooth_voicings(payload_json):
    """Re-voice each chord to minimize movement from the previous one."""
    params = json.loads(payload_json)
    notes = [n for n in params["notes"] if not n.get("muted")]

    result = []
    previous = None
    revoiced = 0
    for cluster in _cluster_chords(notes):
        ordered = sorted(cluster["notes"], key=lambda n: n["pitch"])
        pitches = [n["pitch"] for n in ordered]
        if len(set(pitches)) < 2:
            result.extend(cluster["notes"])
            continue

        if previous is None:
            voiced = pitches
        else:
            center = sum(pitches) / len(pitches)

            def cost(candidate):
                # Total movement from the previous chord (nearest-pitch,
                # both directions), plus a drift penalty to stay near the
                # chord's original register.
                movement = sum(
                    min(abs(p - q) for q in previous) for p in candidate
                ) + sum(min(abs(p - q) for q in candidate) for p in previous)
                drift = abs(sum(candidate) / len(candidate) - center)
                return movement + 0.5 * drift

            voiced = min(_voicing_candidates(pitches), key=cost)
            if voiced != pitches:
                revoiced += 1

        if any(not 0 <= p <= 127 for p in voiced):
            voiced = pitches  # out of MIDI range — keep the original
        for note, pitch in zip(ordered, voiced):
            new = dict(note)
            new["pitch"] = pitch
            result.append(new)
        previous = voiced

    if previous is None:
        return json.dumps({
            "error": "No chords to re-voice — the clip looks monophonic."
        })
    return json.dumps({"notes": result, "revoiced": revoiced})


def _root_pc(name):
    """Pitch class for a note name like 'C#', 'Db', or 'A'."""
    name = _FLATS_REVERSED.get(name, name)
    return TONICS.index(name) if name in TONICS else None


def _stacked_pitches(chord, octave):
    """Chord tones voiced as an ascending stack from the root octave.

    Chord.from_name returns tones in arbitrary octaves, so re-stack them:
    root at the requested octave, every later tone above the previous one.
    """
    pcs = [t.midi % 12 for t in chord.tones]
    pitch = pcs[0] + 12 * (octave + 1)
    stacked = [pitch]
    for pc in pcs[1:]:
        pitch += (pc - pitch) % 12 or 12
        stacked.append(pitch)
    return stacked


def generate_from_symbols(payload_json):
    params = json.loads(payload_json)
    symbols = params.get("symbols", "").replace(",", " ").split()
    octave = int(params.get("octave", 4))
    beats = float(params.get("beatsPerChord", 4))
    if not symbols:
        return json.dumps({"error": "No chord symbols given."})

    chords = []
    unknown = []
    for symbol in symbols:
        try:
            chords.append(Chord.from_name(symbol))
        except (ValueError, KeyError):
            unknown.append(symbol)
    if unknown:
        return json.dumps({
            "error": f"Unknown chord {'symbols' if len(unknown) > 1 else 'symbol'}: "
                     f"{', '.join(unknown)}. Try names like Am7, Bb, Cmaj7, F#m, G7."
        })

    notes = []
    for i, chord in enumerate(chords):
        for pitch in _stacked_pitches(chord, octave):
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
        "name": " ".join(symbols),
    })


def generate_bassline(payload_json):
    params = json.loads(payload_json)
    source = [n for n in json.loads(json.dumps(params["notes"])) if not n.get("muted")]
    style = params.get("style", "root-fifth")
    octave = int(params.get("octave", 2))

    clusters = []
    for cluster in _cluster_chords(source):
        pitches = sorted({n["pitch"] for n in cluster["notes"]})
        if len({p % 12 for p in pitches}) < 2:
            continue
        chord = Chord([Tone.from_midi(p) for p in pitches])
        identified = chord.identify()
        root = None
        if identified:
            root = _root_pc(identified.partition(" ")[0])
        if root is None:
            root = pitches[0] % 12
        pcs = {p % 12 for p in pitches}
        third = next((pc for pc in pcs if (pc - root) % 12 in (3, 4)), root)
        fifth = next((pc for pc in pcs if (pc - root) % 12 == 7), (root + 7) % 12)
        end = max(n["startTime"] + n["duration"] for n in cluster["notes"])
        clusters.append({
            "start": cluster["start"], "end": end,
            "root": root, "third": third, "fifth": fifth,
        })
    if not clusters:
        return json.dumps({
            "error": "No chords found to build a bassline from."
        })

    def place(pc):
        return min(127, max(0, pc + 12 * (octave + 1)))

    notes = []

    def emit(pitch, start, duration, accent=False):
        notes.append({
            "pitch": pitch,
            "startTime": round(start, 6),
            "duration": round(duration, 6),
            "velocity": 110 if accent else 96,
        })

    for i, c in enumerate(clusters):
        span = c["end"] - c["start"]
        if style == "roots":
            emit(place(c["root"]), c["start"], span, accent=True)
        elif style == "root-fifth":
            beat = c["start"]
            toggle = True
            while beat < c["end"] - 1e-9:
                duration = min(1.0, c["end"] - beat)
                emit(place(c["root"] if toggle else c["fifth"]), beat, duration,
                     accent=toggle)
                toggle = not toggle
                beat += duration
        elif style == "arpeggio":
            pattern = [c["root"], c["third"], c["fifth"], c["third"]]
            beat = c["start"]
            j = 0
            while beat < c["end"] - 1e-9:
                duration = min(0.5, c["end"] - beat)
                emit(place(pattern[j % 4]), beat, duration, accent=j % 4 == 0)
                j += 1
                beat += duration
        elif style == "walking":
            tones = [c["root"], c["third"], c["fifth"], c["third"]]
            steps = max(1, int(round(span)))
            for j in range(steps):
                beat = c["start"] + j
                duration = min(1.0, c["end"] - beat)
                if j == steps - 1 and i + 1 < len(clusters):
                    # Chromatic approach into the next root, from below or
                    # above, whichever is closer.
                    next_root = place(clusters[i + 1]["root"])
                    current = place(tones[(j - 1) % 4]) if j else place(c["root"])
                    pitch = next_root - 1 if current <= next_root else next_root + 1
                    emit(min(127, max(0, pitch)), beat, duration)
                else:
                    emit(place(tones[j % 4]), beat, duration, accent=j == 0)
        else:
            return json.dumps({"error": f"Unknown bassline style: {style}"})

    return json.dumps({
        "notes": notes,
        "length": clusters[-1]["end"],
        "name": f"bass ({style})",
    })


def _sequential_clusters(notes):
    """Clusters if the clip is a simple chord/melody sequence, else None."""
    clusters = _cluster_chords(notes)
    position = -1.0
    for cluster in clusters:
        starts = {round(n["startTime"], 3) for n in cluster["notes"]}
        ends = {round(n["startTime"] + n["duration"], 3) for n in cluster["notes"]}
        if len(starts) > 1 or len(ends) > 1:
            return None
        if cluster["start"] < position - 1e-6:
            return None
        position = max(ends)
    return clusters


def notation(payload_json):
    params = json.loads(payload_json)
    notes = [n for n in params["notes"] if not n.get("muted")]
    title = params.get("title") or "Untitled"
    bpm = float(params.get("bpm", 120))
    if not notes:
        return json.dumps({"error": "This clip has no unmuted notes."})

    key = Key.detect(*_note_names(n["pitch"] for n in notes))
    tonic = key.tonic_name if key else "C"
    mode = key.mode if key and key.mode in ("major", "minor") else "major"

    score = Score(bpm=bpm)

    def fill_part(part, events):
        """events: (start, duration, pitches) tuples, sequential."""
        position = 0.0
        for start, duration, pitches in events:
            gap = start - position
            if gap > 1e-6:
                part.rest(_RawDuration(gap))
            tones = [Tone.from_midi(p) for p in sorted(pitches)]
            part.add(
                tones[0] if len(tones) == 1 else Chord(tones),
                _RawDuration(duration),
            )
            position = start + duration

    sequential = _sequential_clusters(notes)
    if sequential:
        part = score.part(title or "part")
        fill_part(part, [
            (
                c["start"],
                max(n["duration"] for n in c["notes"]),
                [n["pitch"] for n in c["notes"]],
            )
            for c in sequential
        ])
    else:
        # Polyphonic with overlaps — split into voices, one staff each.
        notes.sort(key=lambda n: (n["startTime"], n["pitch"]))
        voices = []
        for note in notes:
            voice = next(
                (v for v in voices if v["end"] <= note["startTime"] + 1e-6),
                None,
            )
            if voice is None:
                if len(voices) >= 8:
                    continue
                voice = {"end": 0.0, "events": []}
                voices.append(voice)
            voice["events"].append(note)
            voice["end"] = note["startTime"] + note["duration"]
        for i, voice in enumerate(voices):
            part = score.part(f"voice {i + 1}")
            fill_part(part, [
                (n["startTime"], n["duration"], [n["pitch"]])
                for n in voice["events"]
            ])

    abc_key = tonic + ("m" if mode == "minor" else "")
    try:
        abc = score.to_abc(title=title, key=abc_key)
        lilypond = score.to_lilypond(title=title, key=tonic, mode=mode)
    except (KeyError, ValueError) as e:
        return json.dumps({"error": f"Couldn't engrave this clip: {e}"})

    return json.dumps({
        "abc": abc,
        "lilypond": lilypond,
        "key": str(key) if key else None,
    })


def render_audio(payload_json):
    params = json.loads(payload_json)
    notes = [n for n in params["notes"] if not n.get("muted")]
    instrument = params.get("instrument", "piano")
    bpm = float(params.get("bpm", 120))
    if not notes:
        return json.dumps({"error": "This clip has no unmuted notes."})
    if instrument not in INSTRUMENTS:
        return json.dumps({"error": f"Unknown instrument: {instrument}"})

    # Split overlapping notes into monophonic voices, one Part per voice.
    notes.sort(key=lambda n: (n["startTime"], n["pitch"]))
    voices = []
    for note in notes:
        voice = next(
            (v for v in voices if v["end"] <= note["startTime"] + 1e-6), None
        )
        if voice is None:
            if len(voices) >= 24:
                continue  # cap polyphony to keep render times sane
            voice = {"end": 0.0, "events": []}
            voices.append(voice)
        voice["events"].append(note)
        voice["end"] = note["startTime"] + note["duration"]

    score = Score(bpm=bpm)
    for i, voice in enumerate(voices):
        part = score.part(f"voice {i + 1}", instrument=instrument)
        position = 0.0
        for note in voice["events"]:
            gap = note["startTime"] - position
            if gap > 1e-6:
                part.rest(_RawDuration(gap))
            part.add(
                Tone.from_midi(note["pitch"]),
                _RawDuration(note["duration"]),
                velocity=int(note.get("velocity", 100)),
            )
            position = note["startTime"] + note["duration"]

    import numpy as np

    samples = render_score(score)
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes()
    return json.dumps({
        "pcmBase64": base64.b64encode(pcm).decode(),
        "sampleRate": 44100,
        "channels": int(samples.shape[1]),
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
