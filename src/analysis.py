"""Analysis helpers run inside Pyodide, bridging Live's MIDI notes to pytheory.

Each function takes a JSON payload string and returns a JSON string for the
extension to render. Clip notes are NoteDescription objects from the
Extensions SDK: pitch, startTime, duration, muted, ...
"""

import base64
import itertools
import json
import random
import re

from pytheory import Chord, Fretboard, Key, Raga, Tone, TonedScale, render_score
from pytheory.rhythm import INSTRUMENTS, Pattern, Score, _RawDuration
from pytheory.scales import PROGRESSIONS
# Not the package-level Scale — pytheory/__init__ aliases that to TonedScale,
# which lacks the detect/recommend static methods.
from pytheory.scales import Scale

TONICS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
          "Db", "Eb", "Gb", "Ab", "Bb"]
DEFAULT_VELOCITY = 100


def _note_names(pitches):
    """Unique pitch-class names, in order of first appearance."""
    return list(dict.fromkeys(Tone.from_midi(p).name for p in pitches))


def _scale_names():
    return [s for s in TonedScale(tonic="C4").scales if s != "chromatic"]


def _chord_label(chord):
    return chord.symbol or chord.identify()


def _chord_note_names(chord):
    """Spell MIDI-derived notes by chord degree, retaining their registers.

    MIDI has no enharmonic information. Use the identified symbol's spelling
    (e.g. C augmented is C E G#, not C E Ab).
    Unrecognized chords retain their original notes.
    """
    symbol = chord.symbol
    if not symbol:
        return [str(t) for t in chord.tones]
    try:
        spelled = Chord.from_symbol(symbol)
    except (ValueError, KeyError):
        return [str(t) for t in chord.tones]
    names = {t.midi % 12: t.name for t in spelled.tones}
    result = []
    for tone in chord.tones:
        name = names.get(tone.midi % 12, tone.name)
        # Compare at a reference octave so B#/Cb retain the right register.
        reference = Tone(name, octave=4, system="western").midi
        octave = 4 + (tone.midi - reference) // 12
        result.append(str(Tone(name, octave=octave, system="western")))
    return result


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
        "ragas": Raga.names(),
        # Semitone offsets of every scale, so the extension can match Live's
        # current scale (Song.scaleIntervals) to a pytheory scale exactly.
        "scaleIntervals": {
            name: _scale_degrees("C", name) for name in _scale_names()
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
            "notes": _chord_note_names(chord),
            "name": chord.identify(),
            "symbol": _chord_label(chord),
            "numeral": numeral,
        })

    if not chords:
        return json.dumps({
            "error": "No chords found — the clip looks monophonic."
        })
    return json.dumps({
        "chords": chords,
        "key": str(key) if key else None,
        "cadences": _cadences(chords),
    })


def _cadences(chords):
    """Label cadential motion between consecutive chords."""
    def base(numeral):
        return numeral.rstrip("7").lstrip("b#").upper() if numeral else None

    cadences = []
    for prev, cur in zip(chords, chords[1:]):
        a, b = base(prev["numeral"]), base(cur["numeral"])
        if not a or not b:
            continue
        kind = None
        if a == "V" and b == "I":
            kind = "authentic"
        elif a == "IV" and b == "I":
            kind = "plagal"
        elif a == "V" and b == "VI":
            kind = "deceptive"
        if kind:
            cadences.append({
                "bar": int(cur["start"] // 4) + 1,
                "type": kind,
                "motion": f"{prev['numeral']} → {cur['numeral']}",
            })
    last = chords[-1]
    if base(last["numeral"]) == "V":
        cadences.append({
            "bar": int(last["start"] // 4) + 1,
            "type": "half",
            "motion": f"ends on {last['numeral']}",
        })
    return cadences


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
    # reject anything that isn't a degree I–VII (b/# prefixes, qualities
    # like maj7/ø7/9, and secondary dominants like V/V are all fine).
    for numeral in numerals:
        if not _valid_numeral(numeral):
            return json.dumps({"error": f"'{numeral}' isn't a Roman numeral I–VII."})

    try:
        key = Key(tonic, mode)
    except (KeyError, ValueError) as e:
        return json.dumps({"error": f"Unknown key {tonic} {mode}: {e}"})
    chords = []
    for numeral in numerals:
        try:
            chords.append(key.progression(numeral)[0])
        except (KeyError, ValueError, IndexError) as e:
            return json.dumps({
                "error": f"Couldn't build '{numeral}' in {tonic} {mode}: {e}"
            })

    if "voicing" in params:
        try:
            degrees = _scale_degrees(tonic, mode)
        except (KeyError, ValueError):
            degrees = []
        specs = []
        for chord in chords:
            pcs = list(dict.fromkeys(t.midi % 12 for t in chord.tones))
            specs.append(_sized(pcs[0], pcs, params.get("size", "as-written"), degrees))
        return _layout_progression(
            specs, params, beats, f"{tonic} {mode}: {'-'.join(numerals)}",
            root_names=[chord.tones[0].name for chord in chords],
        )

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


_NUMERAL = re.compile(r"^[b#♭♯]?(VII|VI|IV|V|III|II|I)(?![IV])", re.IGNORECASE)


def _valid_numeral(numeral):
    """A Roman numeral pytheory will place correctly (I–VII, maybe X/Y)."""
    parts = numeral.split("/")
    return 1 <= len(parts) <= 2 and all(_NUMERAL.match(p) for p in parts)


def _sized(root, pcs, size, degrees):
    """Reshape a chord to the requested size: as written, triad, 7th, 9th."""
    ordered = _stack_order(root, pcs)
    if size in (None, "", "as-written"):
        return root, ordered
    third_and_fifth = [pc for pc in ordered if (pc - root) % 12 in (3, 4, 6, 7, 8)]
    triad = [root] + third_and_fifth[:2]
    if size == "triad":
        return root, triad
    if size not in ("seventh", "ninth"):
        raise ValueError(f"Unknown chord size: {size}")

    def from_scale(steps, fallback):
        if root in degrees and len(degrees) == 7:
            return degrees[(degrees.index(root) + steps) % 7]
        return (root + fallback) % 12

    seventh = next((pc for pc in ordered if (pc - root) % 12 in (9, 10, 11)), None)
    if seventh is None:
        seventh = from_scale(6, 10)
        if (seventh - root) % 12 not in (9, 10, 11):
            seventh = (root + 10) % 12
    chord = triad + [seventh]
    if size == "ninth":
        ninth = from_scale(1, 2)
        if (ninth - root) % 12 == 2:  # skip a crunchy b9 (iii in major)
            chord.append(ninth)
    return root, chord


# Chord rhythms: (offset, length) hits inside a repeating cycle of beats.
CHORD_RHYTHMS = {
    "sustain": (None, []),
    "quarters": (1.0, [(0.0, 0.5)]),
    "offbeat": (1.0, [(0.5, 0.25)]),
    "eighths": (0.5, [(0.0, 0.4)]),
    "sixteenths": (0.25, [(0.0, 0.18)]),
    "dotted": (4.0, [(0.0, 1.25), (1.5, 1.25), (3.0, 0.75)]),
    "charleston": (4.0, [(0.0, 0.75), (1.5, 0.5)]),
    "push": (None, []),
}


def _rhythm_hits(rhythm, span):
    """(offset, length, accent) hits for one chord lasting `span` beats."""
    if rhythm not in CHORD_RHYTHMS:
        raise ValueError(f"Unknown chord rhythm: {rhythm}")
    cycle, pattern = CHORD_RHYTHMS[rhythm]
    if cycle is None:
        return [(0.0, span, True)]
    hits = []
    start = 0.0
    while start < span - 1e-9:
        for offset, length in pattern:
            t = start + offset
            if t < span - 1e-9:
                hits.append((round(t, 6), round(min(length, span - t), 6),
                             abs(t % 4) < 1e-9))
        start += cycle
    return hits


def _layout_progression(specs, params, beats, name, basses=None, root_names=None):
    """Voice (root, pcs) chords and lay them out with a chord rhythm."""
    rhythm = params.get("rhythm", "sustain")
    try:
        settings = _voicing_params(params)
        bass = settings.pop("bass")
        voiced = _voice_chords(specs, **settings)
        hits = _rhythm_hits(rhythm, beats)
    except ValueError as e:
        return json.dumps({"error": str(e)})

    notes = []
    labels = []
    total = len(specs) * beats
    for i, ((root, pcs), pitches) in enumerate(zip(specs, voiced)):
        start = i * beats
        labels.append(_name_chord(root, pcs,
                                  root_name=root_names[i] if root_names else None))
        if rhythm == "push":
            # Anticipate each change by an eighth, the way a band pushes.
            begin = start - 0.5 if i > 0 else start
            end = start + beats - (0.5 if i + 1 < len(specs) else 0.0)
            chord_hits = [(begin - start, end - begin, True)]
        else:
            chord_hits = hits
        for offset, length, accent in chord_hits:
            velocity = DEFAULT_VELOCITY if rhythm in ("sustain", "push") else (
                108 if accent else 92)
            for pitch in pitches:
                notes.append({
                    "pitch": pitch,
                    "startTime": round(start + offset, 6),
                    "duration": round(length, 6),
                    "velocity": velocity,
                })
        bass_pc = basses[i] if basses and basses[i] is not None else (root if bass else None)
        if bass_pc is not None:
            notes.append({
                "pitch": _bass_under(bass_pc, pitches, settings["octave"]),
                "startTime": start,
                "duration": beats,
                "velocity": DEFAULT_VELOCITY,
            })
    if rhythm != "sustain":
        name += f" ({rhythm})"
    return json.dumps({
        "notes": notes,
        "length": total,
        "name": name,
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


def generate_raga(payload_json):
    """Lay out a Hindustani raga's aroha (then avaroha) as a MIDI clip.

    Notes are the raga's swaras voiced from Sa = the chosen tonic. (MIDI
    is 12-TET, so the shruti micro-tuning isn't represented here — the
    clip is the raga's melodic skeleton; for the just-intoned audio use
    ``Raga.play()``.)
    """
    params = json.loads(payload_json)
    sa = params.get("tonic", "C")
    octave = int(params.get("octave", 4))
    duration = float(params.get("noteDuration", 0.5))
    descend = params.get("descend", True)

    try:
        raga = Raga.get(params["raga"])
    except KeyError:
        return json.dumps({"error": f"Unknown raga: {params.get('raga')!r}"})

    tones = raga.aroha_tones(f"{sa}{octave}")
    if descend:
        tones = tones + raga.avaroha_tones(f"{sa}{octave}")[1:]
    pitches = [t.midi for t in tones]

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
        "name": f"{sa} {raga.name} — {raga.thaat} thaat, {raga.time}",
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


ARP_STYLES = ("up", "down", "updown", "downup", "converge", "diverge",
              "pinky", "thumb", "random", "chord")


def _arp_sequence(pitches, style, octaves, rng):
    """One cycle of an arpeggio over sorted pitches, across `octaves`."""
    ladder = [p + 12 * o for o in range(octaves) for p in pitches]
    ladder = [p for p in ladder if 0 <= p <= 127] or list(pitches)
    if style == "down":
        return list(reversed(ladder))
    if style == "updown":
        return ladder + ladder[-2:0:-1]
    if style == "downup":
        down = list(reversed(ladder))
        return down + down[-2:0:-1]
    if style == "converge":
        # Outside in: lowest, highest, next lowest, next highest...
        out, lo, hi = [], 0, len(ladder) - 1
        while lo <= hi:
            out.append(ladder[lo])
            if lo != hi:
                out.append(ladder[hi])
            lo, hi = lo + 1, hi - 1
        return out
    if style == "diverge":
        # Inside out: the converge order, reversed.
        return list(reversed(_arp_sequence(pitches, "converge", octaves, rng)))
    if style == "pinky":
        # The top note is a pedal between every other step.
        top, rest = ladder[-1], ladder[:-1]
        return [x for p in rest for x in (p, top)] or [top]
    if style == "thumb":
        # The bottom note is a pedal between every other step.
        bottom, rest = ladder[0], ladder[1:]
        return [x for p in rest for x in (bottom, p)] or [bottom]
    if style == "random":
        shuffled = list(ladder)
        rng.shuffle(shuffled)
        return shuffled
    return ladder  # "up"


def _swung(t, grid, amount):
    """Delay every second grid step by `amount` (1.0 = full triplet swing)."""
    if amount <= 0 or grid <= 0:
        return t
    step = t / grid
    if abs(step - round(step)) < 1e-6 and round(step) % 2 == 1:
        return t + amount * grid / 3
    return t


def arpeggiate(payload_json):
    """Replace block chords with arpeggios.

    rate in beats (0.333/0.1667 for triplets), octaves 1–4, gate as a
    fraction of the step, swing 0–1 on odd steps, accent on each beat.
    "chord" style retriggers the whole chord on the grid (a gated pad).
    """
    params = json.loads(payload_json)
    notes = [n for n in params["notes"] if not n.get("muted")]
    rate = float(params.get("rate", 0.25))
    style = params.get("style", "up")
    octaves = max(1, min(4, int(params.get("octaves", 1))))
    gate = max(0.05, min(1.0, float(params.get("gate", 1.0))))
    swing = max(0.0, min(1.0, float(params.get("swing", 0))))
    accent = params.get("accent") in (True, "yes", "on")
    if style not in ARP_STYLES:
        return json.dumps({"error": f"Unknown arpeggio style: {style}"})
    if rate <= 0:
        return json.dumps({"error": "The arpeggio rate must be positive."})
    rng = _rng(params)

    result = []
    arpeggiated = 0
    for cluster in _cluster_chords(notes):
        pitches = sorted({n["pitch"] for n in cluster["notes"]})
        if len(pitches) < 2:
            result.extend(cluster["notes"])
            continue

        sequence = _arp_sequence(pitches, style, octaves, rng)
        arpeggiated += 1
        start = cluster["start"]
        end = max(n["startTime"] + n["duration"] for n in cluster["notes"])
        velocity = max(
            (n.get("velocity", 100) for n in cluster["notes"]), default=100
        )
        i = 0
        t = start
        while t < end - 1e-9:
            onset = _swung(t, rate, swing)
            length = min(rate * gate, end - onset)
            if length > 1e-6:
                on_beat = abs(t - round(t)) < 1e-6
                hit_velocity = (min(127, velocity + 12) if on_beat else max(1, velocity - 8)) \
                    if accent else velocity
                if style == "random" and i and i % len(sequence) == 0:
                    rng.shuffle(sequence)
                chord_hit = pitches if style == "chord" else [sequence[i % len(sequence)]]
                for pitch in chord_hit:
                    result.append({
                        "pitch": pitch,
                        "startTime": round(onset, 6),
                        "duration": round(length, 6),
                        "velocity": hit_velocity,
                    })
            i += 1
            t = start + i * rate

    if not arpeggiated:
        return json.dumps({
            "error": "No chords to arpeggiate — the clip looks monophonic."
        })
    return json.dumps({"notes": result, "arpeggiated": arpeggiated})


def strum(payload_json):
    """Roll each chord's notes like a strummed guitar or a harp.

    direction: down (low to high, like a downstroke), up, or alternate
    (down on chords that land on a beat, up on the ones in between, the
    way a strumming hand moves). speed: milliseconds between strings,
    converted to beats at the Set's tempo. Each chord still ends where it
    did, and later strings ring a touch softer.
    """
    params = json.loads(payload_json)
    notes = params["notes"]
    direction = params.get("direction", "down")
    if direction not in ("down", "up", "alternate"):
        return json.dumps({"error": f"Unknown strum direction: {direction}"})
    bpm = float(params.get("bpm", 120)) or 120
    delta = float(params.get("speed", 25)) / 1000 * bpm / 60  # ms to beats
    taper = float(params.get("taper", 0.04))

    sounding = [n for n in notes if not n.get("muted")]
    clusters = [c for c in _cluster_chords(sounding)
                if len({n["pitch"] for n in c["notes"]}) >= 2]
    if not clusters:
        return json.dumps({"error": "No chords to strum — the clip looks monophonic."})

    strummed_ids = set()
    result = []
    for cluster in clusters:
        ordered = sorted(cluster["notes"], key=lambda n: n["pitch"])
        if direction == "up" or (
            direction == "alternate" and abs(cluster["start"] - round(cluster["start"])) > 1e-6
        ):
            ordered.reverse()
        for i, note in enumerate(ordered):
            strummed_ids.add(id(note))
            new = dict(note)
            end = note["startTime"] + note["duration"]
            new["startTime"] = round(cluster["start"] + i * delta, 6)
            new["duration"] = round(max(0.01, end - new["startTime"]), 6)
            new["velocity"] = max(1, round(note.get("velocity", 100) * (1 - taper * i)))
            result.append(new)
    result.extend(n for n in notes if id(n) not in strummed_ids)
    return json.dumps({"notes": result, "strummed": len(clusters)})


def humanize(payload_json):
    """Loosen a clip: groove quantize, swing, timing and velocity drift.

    Order of work: pull toward the grid (quantize at `strength`), swing
    the off-steps, nudge every onset by up to `timing` ms, and vary
    velocity by up to `velocity`. `liveVelocity` writes Live's own
    velocity deviation instead, so every loop pass plays differently.
    """
    params = json.loads(payload_json)
    notes = params["notes"]
    bpm = float(params.get("bpm", 120)) or 120
    grid = float(params.get("grid") or 0)
    strength = max(0.0, min(1.0, float(params.get("strength", 0))))
    swing = max(0.0, min(1.0, float(params.get("swing", 0))))
    timing_beats = float(params.get("timing", 0)) / 1000 * bpm / 60
    velocity_range = int(params.get("velocity", 0))
    live_velocity = int(params.get("liveVelocity", 0))
    rng = _rng(params)

    sounding = [n for n in notes if not n.get("muted")]
    if not sounding:
        return json.dumps({"error": "This clip has no unmuted notes."})

    result = []
    moved = 0
    for note in notes:
        new = dict(note)
        if note.get("muted"):
            result.append(new)
            continue
        t = note["startTime"]
        if grid > 0:
            target = round(t / grid) * grid
            t += (target - t) * strength
            t = _swung(target, grid, swing) + (t - target) if swing else t
        if timing_beats > 0:
            # Gaussian drift, clipped to the range: most notes move a little.
            t += max(-timing_beats, min(timing_beats, rng.gauss(0, timing_beats / 2)))
        t = max(0.0, t)
        if velocity_range:
            v = note.get("velocity", 100) + rng.randint(-velocity_range, velocity_range)
            new["velocity"] = max(1, min(127, v))
        if live_velocity:
            new["velocityDeviation"] = max(-127, min(127, live_velocity))
        if abs(t - note["startTime"]) > 1e-9:
            moved += 1
        new["startTime"] = round(t, 6)  # the whole note moves; length stays
        result.append(new)
    return json.dumps({"notes": result, "moved": moved})


def _transitions():
    """Chord-to-chord transition counts mined from the progression corpus."""
    counts = {}
    for numerals in PROGRESSIONS.values():
        pairs = list(zip(numerals, numerals[1:])) + [(numerals[-1], numerals[0])]
        for a, b in pairs:
            counts.setdefault(a, {})
            counts[a][b] = counts[a].get(b, 0) + 1
    return counts


def _chord_root_pc(chord):
    """Pitch class (0–11) of a chord's root, via its identified name."""
    name = chord.identify()
    if not name:
        return chord.tones[0].midi % 12
    return _root_pc(name.split()[0])


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

    # Group the key's diatonic chords by harmonic function so the user can
    # see which chords are interchangeable (same function ≈ same job).
    fams = key.chords_by_function()
    fam_roots = {
        fn: {_chord_root_pc(c) for c in chords} for fn, chords in fams.items()
    }

    def function_of(pc):
        for fn, roots in fam_roots.items():
            if pc in roots:
                return fn
        return None

    suggestions = []
    for next_numeral, count in ranked[:6]:
        symbol, tones = _chord_for_numeral(key, next_numeral)
        if symbol:
            pc = Tone.from_string(tones[0]).midi % 12 if tones else None
            suggestions.append({
                "numeral": next_numeral,
                "symbol": symbol,
                "notes": tones,
                "count": count,
                "function": function_of(pc) if pc is not None else None,
            })

    families = {
        fn: [_chord_label(c) for c in chords] for fn, chords in fams.items()
    }
    last_function = function_of(_chord_root_pc(last))

    # Circle-of-fifths neighbours (a fifth either way) and the chords they
    # share with this key — the smoothest places to modulate to.
    cof = key.circle_of_fifths()
    neighbors = [
        {
            "direction": direction,
            "key": str(cof[direction]["key"]),
            "sharedChords": cof[direction]["shared_chords"],
        }
        for direction in ("dominant", "subdominant")
    ]

    return json.dumps({
        "key": str(key),
        "lastChord": {"symbol": _chord_label(last), "numeral": numeral,
                      "function": last_function},
        "suggestions": suggestions,
        "families": families,
        "neighbors": neighbors,
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
        root_pc = _root_pc(root_name)
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

    def chromatic_role(i):
        """How an out-of-scale note moves: passing, neighbor, or free."""
        prev = notes[i - 1]["pitch"] if i > 0 else None
        nxt = notes[i + 1]["pitch"] if i + 1 < len(notes) else None
        pitch = notes[i]["pitch"]
        if prev is None or nxt is None:
            return "chromatic"
        approach = pitch - prev
        departure = nxt - pitch
        if abs(approach) <= 2 and abs(departure) <= 2:
            if prev == nxt:
                return "neighbor"
            if approach * departure > 0:
                return "passing"
        return "chromatic"

    rows = []
    histogram = {}
    in_scale = 0
    for i, note in enumerate(notes):
        pc = note["pitch"] % 12
        label = degree_label(pc)
        if pc in degrees:
            in_scale += 1
            role = None
        else:
            role = chromatic_role(i)
        histogram[label] = histogram.get(label, 0) + 1
        rows.append({
            "name": str(Tone.from_midi(note["pitch"])),
            "degree": label,
            "role": role,
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
    """Mirror notes around the key's tonic–dominant axis.

    Routes each note through pytheory's negative-harmony code path
    (``Chord.negative_harmony``) and reports the axis plus the bridge
    chord — the negative dominant — from ``Key.negative_harmony``.
    """
    params = json.loads(payload_json)
    notes = params["notes"]
    tonic = params["tonic"]

    changed = 0
    mirrored = []
    for note in notes:
        new = dict(note)
        if not note.get("muted"):
            pitch = note["pitch"]
            reflected = (Chord(tones=[Tone.from_midi(pitch)])
                         .negative_harmony(tonic).tones[0])
            new_pitch = min(127, max(0, reflected.midi))
            if new_pitch != pitch:
                new["pitch"] = new_pitch
                changed += 1
        mirrored.append(new)

    info = Key(tonic, "major").negative_harmony()
    bridge = info["negative_dominant"]
    return json.dumps({
        "notes": mirrored,
        "changed": changed,
        "axis": list(info["axis"]),
        "axisNotes": list(info["axis_notes"]),
        "bridgeChord": bridge.symbol or bridge.identify(),
    })


def reharmonize(payload_json):
    """Reharmonize a chord clip's progression with a chosen technique.

    Clusters the clip into chords, detects the key, runs pytheory's
    ``reharmonize_progression`` (``secondary_dominants`` inserts the
    cycle-of-dominants, so the chord count can grow), and lays the new
    progression evenly back across the clip's length.
    """
    from pytheory import reharmonize_progression

    params = json.loads(payload_json)
    notes = [n for n in params["notes"] if not n.get("muted")]
    technique = params.get("technique", "secondary_dominants")
    if not notes:
        return json.dumps({"error": "This clip has no unmuted notes."})

    clusters = [c for c in _cluster_chords(notes)
                if len({n["pitch"] % 12 for n in c["notes"]}) >= 2]
    if not clusters:
        return json.dumps({"error": "No chords found to reharmonize — "
                                    "this looks like a melody, not a progression."})

    tonic = params.get("tonic")
    if not tonic:
        key = Key.detect(*_note_names(n["pitch"] for n in notes))
        tonic = key.tonic_name if key else "C"

    chords = [Chord([Tone.from_midi(p)
                     for p in sorted({n["pitch"] for n in cl["notes"]})])
              for cl in clusters]
    try:
        new_chords = reharmonize_progression(chords, tonic, technique=technique)
    except Exception as e:
        return json.dumps({"error": f"Reharmonize failed: {e}"})

    total = max((n["startTime"] + n["duration"] for n in notes), default=4.0)
    per = total / len(new_chords)
    out = []
    for i, ch in enumerate(new_chords):
        for t in ch.tones:
            if t.midi is None:
                continue
            out.append({
                "pitch": min(127, max(0, t.midi)),
                "startTime": i * per,
                "duration": per,
                "velocity": 90,
            })
    return json.dumps({
        "notes": out,
        "key": tonic,
        "technique": technique,
        "before": len(chords),
        "after": len(new_chords),
        "symbols": [c.symbol or c.identify() for c in new_chords],
    })


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


def invert_notes(payload_json):
    """Mirror the melody around its first note — diatonically when in key."""
    params = json.loads(payload_json)
    notes = params["notes"]
    sounding = [n for n in notes if not n.get("muted")]
    if not sounding:
        return json.dumps({"error": "This clip has no unmuted notes."})

    key = Key.detect(*_note_names(n["pitch"] for n in sounding))
    degrees = _scale_degrees(key.tonic_name, key.mode) if key else None
    ordered = sorted(sounding, key=lambda n: (n["startTime"], n["pitch"]))
    pivot = ordered[0]["pitch"]

    def scale_index(pitch):
        """Position of an in-scale pitch on the infinite scale ladder."""
        pc = pitch % 12
        if degrees is None or pc not in degrees:
            return None
        return (pitch // 12) * len(degrees) + degrees.index(pc)

    def from_scale_index(index):
        octave, degree = divmod(index, len(degrees))
        return octave * 12 + degrees[degree]

    pivot_index = scale_index(pivot)

    changed = 0
    inverted = []
    for note in notes:
        new = dict(note)
        if not note.get("muted"):
            index = scale_index(note["pitch"])
            if pivot_index is not None and index is not None:
                new_pitch = from_scale_index(2 * pivot_index - index)
            else:
                new_pitch = 2 * pivot - note["pitch"]  # chromatic fallback
            new_pitch = min(127, max(0, new_pitch))
            if new_pitch != note["pitch"]:
                new["pitch"] = new_pitch
                changed += 1
        inverted.append(new)

    return json.dumps({"notes": inverted, "changed": changed})


def retrograde_notes(payload_json):
    """Reverse the clip in time."""
    params = json.loads(payload_json)
    notes = params["notes"]
    sounding = [n for n in notes if not n.get("muted")]
    if not sounding:
        return json.dumps({"error": "This clip has no unmuted notes."})

    start = min(n["startTime"] for n in sounding)
    end = max(n["startTime"] + n["duration"] for n in sounding)

    reversed_notes = []
    for note in notes:
        new = dict(note)
        if not note.get("muted"):
            new["startTime"] = round(
                start + (end - (note["startTime"] + note["duration"])), 6
            )
        reversed_notes.append(new)

    return json.dumps({"notes": reversed_notes, "changed": len(sounding)})


def generate_sketch(payload_json):
    """A four-part sketch: chords, bassline, melody, and drums."""
    params = json.loads(payload_json)
    tonic = params["tonic"]
    mode = params["mode"]
    progression_name = params.get("progression", "random")
    drum_pattern = params.get("drumPattern", "house")
    beats = float(params.get("beatsPerChord", 4))

    if progression_name == "random":
        numerals = _random_numerals(4)
    else:
        numerals = list(PROGRESSIONS.get(progression_name, ()))
        if not numerals:
            return json.dumps({"error": f"Unknown progression: {progression_name}"})

    chords = json.loads(generate_progression(json.dumps({
        "tonic": tonic, "mode": mode, "numerals": numerals,
        "octave": 4, "beatsPerChord": beats,
    })))
    if chords.get("error"):
        return json.dumps(chords)
    length = chords["length"]

    bass = json.loads(generate_bassline(json.dumps({
        "notes": chords["notes"], "style": "root-fifth", "octave": 2,
    })))
    melody = json.loads(generate_melody(json.dumps({
        "tonic": tonic, "scale": mode, "octave": 5,
        "bars": max(1, int(length // 4)), "density": "medium",
    })))

    try:
        pattern_beats = Pattern.preset(drum_pattern).beats
    except (KeyError, ValueError) as e:
        return json.dumps({"error": f"Unknown drum pattern: {e}"})
    drums = json.loads(generate_drums(json.dumps({
        "pattern": drum_pattern,
        "repeats": max(1, round(length / pattern_beats)),
    })))

    parts = {"chords": chords, "bass": bass, "melody": melody, "drums": drums}
    for name, part in parts.items():
        if part.get("error"):
            return json.dumps({"error": f"{name}: {part['error']}"})

    return json.dumps({
        "name": chords["name"],
        "key": f"{tonic} {mode}",
        "parts": parts,
    })


def _beats(duration):
    """Beats from a Duration enum or _RawDuration."""
    beats = getattr(duration, "beats", None)
    if beats is not None:
        return float(beats)
    return float(getattr(duration, "value", duration))


def audio_to_midi(payload_json):
    """Transcribe a WAV file (in the virtual FS) into MIDI parts."""
    _patch_scipy_for_wasm()
    params = json.loads(payload_json)
    path = params["path"]
    bpm = params.get("bpm")
    quantize = params.get("quantize") or None
    split = bool(params.get("split"))

    from pytheory.audio import transcribe

    try:
        score = transcribe(
            path,
            bpm=float(bpm) if bpm else None,
            quantize=float(quantize) if quantize else None,
            split=split,
        )
    except Exception as e:  # audio decoding/analysis can fail many ways
        return json.dumps({"error": f"Transcription failed: {e}"})

    parts = {}
    for name, part in score.parts.items():
        position = 0.0
        notes = []
        for note in part.notes:
            beats = _beats(note.duration)
            tone = getattr(note, "tone", None)
            midi = getattr(tone, "midi", None) if tone is not None else None
            if midi is not None:
                notes.append({
                    "pitch": int(midi),
                    "startTime": round(position, 6),
                    "duration": round(beats, 6),
                    "velocity": int(getattr(note, "velocity", 100)),
                })
            position += beats
        if notes:
            parts[name] = {
                "notes": notes,
                "length": round(position, 6),
                "name": name,
            }

    if not parts:
        return json.dumps({
            "error": "No pitched material detected in this audio."
        })
    return json.dumps({"parts": parts, "bpm": score.bpm})


_SCIPY_PATCHED = False


def _patch_scipy_for_wasm():
    """Make scipy's STFT framing safe under wasm32.

    scipy's `_fft_helper` builds a hop-of-1 sliding window view and then
    slices it by the real step. The intermediate view's *virtual* size is
    n_samples x nperseg x 8 bytes — gigabytes for a few seconds of audio —
    which numpy refuses on 32-bit address spaces. Re-frame with the true
    step in the strides instead; the result is identical.
    """
    global _SCIPY_PATCHED
    if _SCIPY_PATCHED:
        return
    import numpy as np
    from scipy import fft as sp_fft
    from scipy.signal import _spectral_py

    def _fft_helper(x, win, detrend_func, nperseg, noverlap, nfft, sides):
        if nperseg == 1 and noverlap == 0:
            result = x[..., np.newaxis]
        else:
            step = nperseg - noverlap
            n_frames = (x.shape[-1] - noverlap) // step
            shape = x.shape[:-1] + (n_frames, nperseg)
            strides = x.strides[:-1] + (step * x.strides[-1], x.strides[-1])
            result = np.lib.stride_tricks.as_strided(
                x, shape=shape, strides=strides, writeable=False
            ).copy()  # overlapping frames must not alias for detrending
        result = detrend_func(result)
        result = win * result
        if sides == "twosided":
            func = sp_fft.fft
        else:
            result = result.real
            func = sp_fft.rfft
        return func(result, n=nfft)

    _spectral_py._fft_helper = _fft_helper
    _SCIPY_PATCHED = True


def audio_detect(payload_json):
    """Key, tempo, and chord progression from a WAV in the virtual FS."""
    _patch_scipy_for_wasm()
    params = json.loads(payload_json)
    path = params["path"]
    bpm = float(params.get("bpm", 120))

    from pytheory.audio import detect_chords, estimate_tempo, load_wav

    try:
        samples, sample_rate = load_wav(path)
        tempo = estimate_tempo(samples, sample_rate)
        chord_track = detect_chords(samples, sample_rate, bpm=bpm)
    except Exception as e:
        return json.dumps({"error": f"Audio analysis failed: {e}"})

    # Key from the full chord tones, not just the roots.
    pitch_classes = []
    for _, _, symbol in chord_track:
        try:
            pitch_classes.extend(
                t.name for t in Chord.from_symbol(symbol.split("/")[0]).tones
            )
        except (ValueError, KeyError):
            pass
    key = Key.detect(*dict.fromkeys(pitch_classes)) if pitch_classes else None

    return json.dumps({
        "key": str(key) if key else None,
        "tempo": round(tempo, 1) if tempo else None,
        "chords": [
            {"start": start, "duration": duration, "symbol": symbol}
            for start, duration, symbol in chord_track
        ],
    })


def sample_pitch(payload_json):
    """Root pitch of a sample, and the transpose needed to reach a tonic."""
    _patch_scipy_for_wasm()
    params = json.loads(payload_json)
    path = params["path"]
    set_tonic = params.get("setTonic")

    import math

    from pytheory.audio import detect_pitch, load_wav

    try:
        samples, sample_rate = load_wav(path)
        times, freqs, voiced = detect_pitch(samples, sample_rate)
    except Exception as e:
        return json.dumps({"error": f"Pitch analysis failed: {e}"})

    pitched = [f for f, v in zip(freqs, voiced) if v and f > 0]
    if not pitched:
        return json.dumps({
            "error": "No stable pitch detected — is this a tonal sample?"
        })

    pitched.sort()
    freq = pitched[len(pitched) // 2]  # median is robust to onset wobble
    exact = 69 + 12 * math.log2(freq / 440.0)
    midi = round(exact)
    cents = round((exact - midi) * 100)
    tone = Tone.from_midi(midi)

    result = {
        "note": f"{tone.name}{tone.octave}",
        "frequency": round(freq, 2),
        "cents": cents,
        "midi": midi,
    }
    if set_tonic in TONICS:
        delta = (_root_pc(set_tonic) - midi) % 12
        if delta > 6:
            delta -= 12
        result["setTonic"] = set_tonic
        result["transpose"] = delta
    return json.dumps(result)


def scene_key(payload_json):
    """Key of a whole scene: all MIDI clips analyzed together and apart."""
    params = json.loads(payload_json)
    clips = params["clips"]

    all_names = []
    per_clip = []
    for clip in clips:
        pitches = [n["pitch"] for n in clip["notes"] if not n.get("muted")]
        if not pitches:
            continue
        names = _note_names(pitches)
        all_names.extend(names)
        clip_key = Key.detect(*names)
        per_clip.append({
            "name": clip["name"],
            "key": str(clip_key) if clip_key else None,
        })

    if not all_names:
        return json.dumps({"error": "No MIDI notes found in this scene."})
    key = Key.detect(*dict.fromkeys(all_names))
    return json.dumps({
        "key": str(key) if key else None,
        "clips": per_clip,
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
    try:
        return Tone.from_string(f"{name}4", system="western").midi % 12
    except (ValueError, KeyError):
        return None


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

    if "voicing" in params:
        specs = []
        basses = []
        for symbol, chord in zip(symbols, chords):
            head, _, slash = symbol.partition("/")
            match = re.match(r"^[A-G][#b]?", head)
            root = _root_pc(match.group(0)) if match else None
            pcs = list(dict.fromkeys(t.midi % 12 for t in chord.tones))
            if root is None or root not in pcs:
                root = pcs[0]
            bass_pc = _root_pc(slash) if slash and re.match(r"^[A-G][#b]?$", slash) else None
            specs.append((root, _stack_order(root, pcs)))
            basses.append(bass_pc)
        roots = [re.match(r"^[A-G][#b]?", sym.partition("/")[0]) for sym in symbols]
        return _layout_progression(
            specs, params, beats, " ".join(symbols), basses,
            root_names=[m.group(0) if m else None for m in roots],
        )

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


# Effect parameters surfaced in the Apply Effects dialog, mapped to the
# keys pytheory's effect chain (_apply_effects_with_params) understands.
_FX_DEFAULTS = {
    "reverb_mix": 0.0, "reverb_type": "algorithmic", "reverb_decay": 1.0,
    "delay_mix": 0.0, "delay_feedback": 0.4, "delay_time": 0.375,
    "lowpass": 0.0, "lowpass_q": 0.707,
    "highpass": 0.0, "highpass_q": 0.707,
    "distortion_mix": 0.0, "distortion_drive": 3.0,
    "chorus_mix": 0.0,
}


def _effect_params(params):
    fx = {}
    for key, default in _FX_DEFAULTS.items():
        if key == "reverb_type":
            fx[key] = params.get(key, default)
        else:
            try:
                fx[key] = float(params.get(key, default))
            except (TypeError, ValueError):
                fx[key] = default
    return fx


def _wav_to_float(data):
    import numpy as np
    if data.dtype == np.int16:
        return data.astype(np.float32) / 32768.0
    if data.dtype == np.int32:
        return data.astype(np.float32) / 2147483648.0
    if data.dtype == np.uint8:
        return (data.astype(np.float32) - 128.0) / 128.0
    return data.astype(np.float32)


def apply_effects(payload_json):
    """Apply pytheory's effect chain to a WAV in the virtual FS.

    Reads the clip's audio (preserving stereo), runs each channel through
    the chosen effects (``_apply_effects_with_params``), and returns
    processed stereo PCM for the extension to drop onto a new audio track.
    """
    _patch_scipy_for_wasm()
    import numpy as np
    import scipy.io.wavfile
    import scipy.signal
    from pytheory.play import _apply_effects_with_params, SAMPLE_RATE

    params = json.loads(payload_json)
    try:
        sr, raw = scipy.io.wavfile.read(params["path"])
    except Exception as e:
        return json.dumps({"error": f"Couldn't read the audio: {e}"})

    data = _wav_to_float(raw)
    if data.ndim == 1:
        data = data[:, None]

    # pytheory's effects are tuned for 44.1 kHz — resample if needed.
    if sr != SAMPLE_RATE:
        n_out = int(round(data.shape[0] * SAMPLE_RATE / sr))
        data = scipy.signal.resample(data, n_out, axis=0).astype(np.float32)

    fx = _effect_params(params)
    # Give time-based effects room to ring out past the clip's end.
    if fx["reverb_mix"] > 0 or fx["delay_mix"] > 0:
        data = np.pad(data, ((0, int(SAMPLE_RATE * 2.0)), (0, 0)))
    chans = [_apply_effects_with_params(data[:, c].copy(), fx)
             for c in range(data.shape[1])]
    n = max(len(c) for c in chans)
    chans = [np.pad(c, (0, n - len(c))) for c in chans]
    out = np.stack(chans, axis=1)
    if out.shape[1] == 1:
        out = np.repeat(out, 2, axis=1)

    pcm = (np.clip(out, -1.0, 1.0) * 32767).astype("<i2").tobytes()
    return json.dumps({
        "pcmBase64": base64.b64encode(pcm).decode(),
        "sampleRate": SAMPLE_RATE,
        "channels": int(out.shape[1]),
        "name": f"{params.get('clipName', 'Audio')} (fx)",
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


# ---------------------------------------------------------------------------
# Voicing engine: shared by Voice Chords, Chordify, and Generate Progression.
#
# A chord travels as (root pitch class, pitch classes in stacking order).
# Voicings are built as MIDI numbers, with pytheory's own voicing methods
# (Chord.inversion / drop2 / drop3 / open_voicing) doing the reshaping.
# ---------------------------------------------------------------------------

VOICING_STYLES = ("close", "open", "drop2", "drop3", "spread", "shell", "power")


def _clamp_pitch(pitch):
    return min(127, max(0, round(pitch)))


def _rng(params):
    """A random source; a fixed seed makes results repeatable (tests)."""
    seed = params.get("seed")
    return random.Random(None if seed in (None, "") else seed)


def _stack_order(root, pcs):
    """Pitch classes ordered for stacking from the root.

    Core tones (third, fifth, sixth, seventh) come first, in interval order;
    with a third present, the 9th/11th (and a 13th over a seventh) sit on top
    as upper extensions instead of crowding the root.
    """
    intervals = sorted({(pc - root) % 12 for pc in pcs} - {0})
    has_third = 3 in intervals or 4 in intervals
    has_seventh = 10 in intervals or 11 in intervals
    upper = set()
    if has_third:
        upper = {1, 2, 5} & set(intervals)
        if has_seventh and 9 in intervals:
            upper.add(9)
    core = [i for i in intervals if i not in upper]
    return [root] + [(root + i) % 12 for i in core + sorted(upper)]


def _close_stack(root, ordered, octave):
    """Root at `octave`, each later tone stacked just above the previous."""
    pitch = root + 12 * (octave + 1)
    stack = [pitch]
    for pc in ordered[1:]:
        pitch += (pc - pitch) % 12 or 12
        stack.append(pitch)
    return stack


def _pt_reshape(pitches, method):
    """Run one of pytheory's voicing methods over MIDI pitches."""
    chord = Chord([Tone.from_midi(p) for p in sorted(pitches)])
    return sorted(t.midi for t in getattr(chord, method)().tones)


def _invert(stack, n):
    """The nth inversion of a close stack, via Chord.inversion."""
    n %= len(stack)
    if n == 0:
        return sorted(stack)
    chord = Chord([Tone.from_midi(p) for p in sorted(stack)])
    return sorted(t.midi for t in chord.inversion(n).tones)


def _shape(stack, style, root):
    """Apply a voicing style to a close stack (any inversion)."""
    pitches = sorted(stack)
    if style == "close" or len(pitches) < 2:
        return pitches
    if style == "drop2" and len(pitches) >= 3:
        return _pt_reshape(pitches, "drop2")
    if style == "drop3":
        return _pt_reshape(pitches, "drop3" if len(pitches) >= 4 else "drop2")
    if style == "open":
        return _pt_reshape(pitches, "open_voicing")
    if style == "spread":
        # Root alone at the bottom, everything else an octave up: a pad.
        low = min(p for p in pitches if p % 12 == root % 12) if any(
            p % 12 == root % 12 for p in pitches) else pitches[0]
        return sorted([low] + [p + 12 if p > low else p + 24 for p in pitches if p != low])
    if style == "shell":
        # Root, third, seventh (or fifth when there's no seventh).
        root_pitch = next((p for p in pitches if p % 12 == root % 12), pitches[0])
        keep = [root_pitch]
        for wanted in ((3, 4), (10, 11, 9), (7,)):
            match = next((p for p in pitches if (p - root) % 12 in wanted and p not in keep), None)
            if match is not None:
                keep.append(match)
            if len(keep) == 3:
                break
        return sorted(keep)
    if style == "power":
        base = next((p for p in pitches if p % 12 == root % 12), pitches[0])
        return [base, base + 7, base + 12]
    return pitches


def _register(shape, center):
    """Shift a shape by octaves so its average sits nearest `center`."""
    mean = sum(shape) / len(shape)
    shift = 12 * round((center - mean) / 12)
    return [p + shift for p in shape]


def _movement(a, b):
    """Voice-leading distance: every voice to its nearest neighbour, both ways."""
    return (sum(min(abs(p - q) for q in b) for p in a)
            + sum(min(abs(p - q) for q in a) for p in b))


def _voicing_cost(previous, candidate, center):
    """Movement from the last chord, drift from the register, and mud."""
    drift = abs(sum(candidate) / len(candidate) - center)
    # Seconds stacked together read as mud: a small penalty each.
    crunch = sum(1 for a, b in itertools.pairwise(candidate) if b - a <= 2)
    return _movement(previous, candidate) + 0.6 * drift + 1.5 * crunch


def _voice_chords(chords, style="close", inversion="smooth", octave=4, bass=False):
    """Voice a sequence of (root, ordered pcs) chords.

    inversion: "smooth" (pick each chord's inversion and octave to move as
    little as possible from the last — first chord in root position),
    or "0".."3" to force an inversion on every chord.
    Returns a list of pitch lists (bass note first when `bass` is set).
    """
    if style not in VOICING_STYLES:
        raise ValueError(f"Unknown voicing: {style}")
    center = 12 * (octave + 1) + 7  # a little above the octave's C
    voiced = []
    previous = None
    for root, ordered in chords:
        if len(ordered) >= 5 and (root + 7) % 12 in ordered:
            # Five-note chords drop their fifth, as players do: the 9th
            # and 7th carry the colour, the fifth just muddies the stack.
            ordered = [pc for pc in ordered if pc != (root + 7) % 12]
        stack = _close_stack(root, ordered, octave)
        if inversion == "smooth" and previous is not None:
            candidates = []
            for n in range(len(stack)):
                shape = _shape(_invert(stack, n), style, root)
                base = _register(shape, center)
                for shift in (-12, 0, 12):
                    candidates.append([p + shift for p in base])

            pitches = min(candidates, key=lambda c, prev=previous: _voicing_cost(prev, c, center))
        else:
            n = 0 if inversion == "smooth" else int(inversion)
            pitches = _register(_shape(_invert(stack, n), style, root), center)
        pitches = sorted({_clamp_pitch(p) for p in pitches})
        previous = pitches
        if bass:
            pitches = [_bass_under(root, pitches, octave)] + pitches
        voiced.append(pitches)
    return voiced


def _bass_under(root, pitches, octave):
    """The root two octaves under the chord's register, below every voice."""
    low = 12 * (octave - 1) + root % 12
    while low >= min(pitches):
        low -= 12
    return _clamp_pitch(low)


def _symbol_for(pitches):
    chord = Chord([Tone.from_midi(p) for p in sorted(set(pitches))])
    return _chord_label(chord)


_SIZE_SUFFIX = {"add9": "add9", "sus2": "sus2", "sus4": "sus4", "power": "5"}


def _name_chord(root, pcs, size=None, root_name=None):
    """Name a chord from its intended root (not its lowest voiced note).

    MIDI-derived names come out sharp; pass `root_name` (e.g. "Bb" from the
    key's spelling) to respell the root.
    """
    symbol = _symbol_for(_close_stack(root, _stack_order(root, pcs), 4))
    if symbol and root_name:
        head = re.match(r"^[A-G][#b]?", symbol)
        if head and _root_pc(head.group(0)) == _root_pc(root_name):
            symbol = root_name + symbol[head.end():]
    if symbol:
        return symbol
    name = root_name or TONICS[root % 12]
    if size == "add9" and (root + 2) % 12 in pcs:
        return name + ("madd9" if (root + 3) % 12 in pcs else "add9")
    return name + _SIZE_SUFFIX[size] if size in ("power",) else f"{name} chord"


def _chord_clusters(notes):
    """Onset clusters holding a real chord (2+ pitch classes), with roots."""
    found = []
    for cluster in _cluster_chords(notes):
        pitches = sorted({n["pitch"] for n in cluster["notes"]})
        pcs = {p % 12 for p in pitches}
        if len(pcs) < 2:
            continue
        chord = Chord([Tone.from_midi(p) for p in pitches])
        identified = chord.identify()
        root = _root_pc(identified.partition(" ")[0]) if identified else None
        if root is None:
            root = pitches[0] % 12
        found.append({
            "start": cluster["start"],
            "end": max(n["startTime"] + n["duration"] for n in cluster["notes"]),
            "notes": cluster["notes"],
            "pitches": pitches,
            "root": root,
            "pcs": _stack_order(root, pcs),
            "chord": chord,
        })
    return found


def _voicing_params(params):
    style = params.get("voicing", "close")
    inversion = str(params.get("inversion", "smooth"))
    if inversion not in ("smooth", "0", "1", "2", "3"):
        raise ValueError(f"Unknown inversion: {inversion}")
    return {
        "style": style,
        "inversion": inversion,
        "octave": int(params.get("octave", 4)),
        "bass": params.get("bass") in (True, "root", "yes"),
    }


def voice_chords(payload_json):
    """Re-voice every chord in a clip: style, inversion, register, bass."""
    params = json.loads(payload_json)
    notes = params["notes"]
    sounding = [n for n in notes if not n.get("muted")]
    try:
        settings = _voicing_params(params)
    except ValueError as e:
        return json.dumps({"error": str(e)})
    clusters = _chord_clusters(sounding)
    if not clusters:
        return json.dumps({"error": "No chords to voice — the clip looks monophonic."})

    try:
        voiced = _voice_chords([(c["root"], c["pcs"]) for c in clusters], **settings)
    except ValueError as e:
        return json.dumps({"error": str(e)})

    chord_ids = {id(n) for c in clusters for n in c["notes"]}
    result = [n for n in notes if id(n) not in chord_ids]
    symbols = []
    for cluster, pitches in zip(clusters, voiced):
        template = max(cluster["notes"], key=lambda n: n.get("velocity", 100))
        velocity = round(sum(n.get("velocity", 100) for n in cluster["notes"])
                         / len(cluster["notes"]))
        for pitch in pitches:
            new = dict(template)
            new.update({
                "pitch": pitch,
                "startTime": cluster["start"],
                "duration": round(cluster["end"] - cluster["start"], 6),
                "velocity": velocity,
            })
            result.append(new)
        symbols.append(_chord_label(cluster["chord"]) or "?")
    return json.dumps({"notes": result, "voiced": len(clusters), "symbols": symbols})


CHORD_SIZES = {
    # Scale-degree offsets stacked on the chosen degree.
    "triad": [0, 2, 4],
    "seventh": [0, 2, 4, 6],
    "ninth": [0, 2, 4, 6, 8],
    "sus2": [0, 1, 4],
    "sus4": [0, 3, 4],
    "add9": [0, 2, 4, 8],
    "power": [0, 4],
}


def _diatonic_chord(degrees, index, size):
    """Pitch classes of the diatonic chord on scale degree `index`.

    Sus chords must be real sus chords (a perfect fifth, and a whole-step
    2nd or perfect 4th): where the scale can't give one on this degree
    (E–F–B in C major), the other sus is tried, then the plain triad.
    """
    def build(steps):
        return [degrees[(index + step) % len(degrees)] for step in steps]

    if size in ("sus2", "sus4"):
        root = degrees[index]
        wanted = {"sus2": [("sus2", 2), ("sus4", 5)],
                  "sus4": [("sus4", 5), ("sus2", 2)]}[size]
        for name, interval in wanted:
            pcs = build(CHORD_SIZES[name])
            if ((pcs[1] - root) % 12, (pcs[2] - root) % 12) == (interval, 7):
                return pcs
        return build(CHORD_SIZES["triad"])
    return build(CHORD_SIZES[size])


# How willing each scale degree is to carry a melody note (pillars first).
_DEGREE_PREFERENCE = {0: 3.0, 3: 2.6, 4: 2.6, 5: 2.2, 1: 1.6, 2: 1.0, 6: 0.6}


def chordify(payload_json):
    """Turn single notes into chords in key.

    mode "root": every note becomes the root of the diatonic chord on its
    scale degree (one-finger chords). mode "top": every note stays on top
    and gets the best-fitting diatonic chord voiced underneath (block
    harmonization). Out-of-key notes get a power chord (root mode) or are
    left alone (top mode).
    """
    params = json.loads(payload_json)
    notes = params["notes"]
    mode = params.get("mode", "root")
    size = params.get("size", "triad")
    if size not in CHORD_SIZES:
        return json.dumps({"error": f"Unknown chord size: {size}"})
    try:
        degrees = _scale_degrees(params["tonic"], params["scale"])
        settings = _voicing_params(params)
    except (KeyError, ValueError) as e:
        return json.dumps({"error": f"Couldn't use that key: {e}"})
    if len(degrees) < 5:
        return json.dumps({"error": "Chordify needs a scale with at least five notes."})

    sounding = [n for n in notes if not n.get("muted")]
    if not sounding:
        return json.dumps({"error": "This clip has no unmuted notes."})
    muted = [n for n in notes if n.get("muted")]

    clusters = _cluster_chords(sounding)
    result = list(muted)
    symbols = []
    if mode == "root":
        chords = []
        for cluster in clusters:
            lead = min(cluster["notes"], key=lambda n: n["pitch"])
            pc = lead["pitch"] % 12
            if pc in degrees:
                pcs = _diatonic_chord(degrees, degrees.index(pc), size)
                if size == "power":
                    pcs = [pc, (pc + 7) % 12]
            else:
                pcs = [pc, (pc + 7) % 12]  # out of key: a neutral power chord
            chords.append((pc, _stack_order(pc, pcs) if size not in ("sus2", "sus4", "power") else pcs))
        try:
            voiced = _voice_chords(chords, **settings)
        except ValueError as e:
            return json.dumps({"error": str(e)})
        for cluster, pitches, (root, pcs) in zip(clusters, voiced, chords):
            lead = min(cluster["notes"], key=lambda n: n["pitch"])
            end = max(n["startTime"] + n["duration"] for n in cluster["notes"])
            for pitch in pitches:
                new = dict(lead)
                new.update({"pitch": pitch, "startTime": cluster["start"],
                            "duration": round(end - cluster["start"], 6)})
                result.append(new)
            symbols.append(_name_chord(root, pcs, size))
    elif mode == "top":
        previous_index = None
        for cluster in clusters:
            top = max(cluster["notes"], key=lambda n: n["pitch"])
            result.extend(cluster["notes"])  # the melody itself stays put
            pc = top["pitch"] % 12
            candidates = [
                i for i in range(len(degrees))
                if pc in _diatonic_chord(degrees, i, size)
            ]
            if not candidates:
                symbols.append("—")
                previous_index = None
                continue

            def score(i, pc=pc, previous=previous_index):
                s = _DEGREE_PREFERENCE.get(i, 0.5)
                if pc != degrees[i]:
                    s += 0.3  # melody on the third or fifth sounds fuller
                if i == previous:
                    s -= 0.9  # keep the harmony moving
                return s

            index = max(candidates, key=score)
            previous_index = index
            pcs = [p for p in _diatonic_chord(degrees, index, size) if p != pc]
            under = sorted(top["pitch"] - ((top["pitch"] - p) % 12 or 12) for p in pcs)
            voicing = under + [top["pitch"]]
            if settings["style"] in ("drop2", "open", "spread") and len(voicing) >= 3:
                voicing[-2] -= 12
            elif settings["style"] == "drop3" and len(voicing) >= 4:
                voicing[-3] -= 12
            voicing = sorted(voicing)
            if settings["bass"]:
                low = degrees[index] + 12 * (settings["octave"] - 1)
                while low >= voicing[0]:
                    low -= 12
                voicing = [low] + voicing
            velocity = max(1, int(top.get("velocity", 100) * 0.85))
            for pitch in voicing[:-1]:
                if not 0 <= pitch <= 127:
                    continue
                new = dict(top)
                new.update({"pitch": pitch, "velocity": velocity})
                result.append(new)
            symbols.append(_name_chord(degrees[index],
                                       _diatonic_chord(degrees, index, size), size))
    else:
        return json.dumps({"error": f"Unknown mode: {mode}"})

    return json.dumps({"notes": result, "chords": len(clusters), "symbols": symbols})
