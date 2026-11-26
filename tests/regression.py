import unittest


class ReleaseRegression(unittest.TestCase):
    def test_spelling(self):
        for symbol, expected in {
            "Ebm": ["Eb", "Gb", "Bb"],
            "Cdim7": ["C", "Eb", "Gb", "Bbb"],
            "F#7": ["F#", "A#", "C#", "E"],
            "Caug": ["C", "E", "G#"],
            "F#m7b5": ["F#", "A", "C", "E"],
        }.items():
            with self.subTest(symbol=symbol):
                chord = Chord.from_name(symbol)
                self.assertEqual([t.name for t in chord.tones], expected)
                names = _chord_note_names(chord)
                self.assertEqual([Tone.from_string(t).name for t in names], expected)
                self.assertEqual([Tone.from_string(t).midi for t in names],
                                 [t.midi for t in chord.tones])

    def test_symbols_to_midi(self):
        symbols = ["Ebm", "Cdim7", "F#7", "Caug", "F#m7b5"]
        result = json.loads(generate_from_symbols(json.dumps({
            "symbols": " ".join(symbols), "octave": 4,
        })))
        self.assertNotIn("error", result)
        self.assertEqual(result["length"], 20)
        self.assertEqual(len(result["notes"]), 18)
        self.assertEqual([n["pitch"] for n in result["notes"][:3]], [63, 66, 70])
        self.assertIn("error", json.loads(generate_from_symbols('{"symbols":"nonsense"}')))

    def test_pitch_class_lookup(self):
        for name, pc in {"Eb": 3, "Gb": 6, "Bbb": 9, "B#": 0, "Cb": 11}.items():
            self.assertEqual(_root_pc(name), pc)
        self.assertIsNone(_root_pc("invalid"))
        self.assertIn("Eb", json.loads(get_options())["tonics"])

    def test_scale_intervals(self):
        intervals = json.loads(get_options())["scaleIntervals"]
        self.assertEqual(intervals["major"], [0, 2, 4, 5, 7, 9, 11])
        self.assertEqual(intervals["dorian"], [0, 2, 3, 5, 7, 9, 10])
        self.assertEqual(intervals["harmonic minor"], [0, 2, 3, 5, 7, 8, 11])

    def test_intervals(self):
        self.assertEqual(Tone.from_string("C4").transpose("m3").name, "Eb")
        self.assertEqual(Tone.from_string("Eb4").add(3, prefer_flats=None).name, "Gb")
        from pytheory import Interval
        self.assertEqual(Interval.MINOR_THIRD, 3)

    def test_detection(self):
        # Input MIDI spellings have no key information. Output must match the
        # detected symbol, without changing the clip's pitches/registers.
        notes = [{"pitch": p, "startTime": 0, "duration": 4} for p in [60, 64, 68]]
        result = json.loads(detect_chords(json.dumps(notes)))
        chord = result["chords"][0]
        self.assertEqual(chord["symbol"], "Caug")
        self.assertEqual([Tone.from_string(t).name for t in chord["notes"]], ["C", "E", "G#"])
        self.assertEqual([Tone.from_string(t).midi for t in chord["notes"]], [60, 64, 68])



def _notes(chords, beats=4):
    return [{"pitch": p, "startTime": i * beats, "duration": beats, "velocity": 100}
            for i, chord in enumerate(chords) for p in chord]


def _by_onset(notes):
    groups = {}
    for n in notes:
        groups.setdefault(n["startTime"], []).append(n["pitch"])
    return [sorted(v) for _, v in sorted(groups.items())]


class Voicings(unittest.TestCase):
    PROGRESSION = [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]]

    def call(self, fn, **payload):
        result = json.loads(fn(json.dumps(payload)))
        self.assertNotIn("error", result, result.get("error"))
        return result

    def test_smooth_close(self):
        result = self.call(voice_chords, notes=_notes(self.PROGRESSION),
                           voicing="close", inversion="smooth", octave=4)
        self.assertEqual(_by_onset(result["notes"]),
                         [[60, 64, 67], [60, 64, 69], [60, 65, 69], [62, 67, 71]])
        self.assertEqual(result["symbols"], ["C", "Am", "F", "G"])

    def test_styles_and_bass(self):
        cmaj7 = _notes([[60, 64, 67, 71]])
        drop2 = _by_onset(self.call(voice_chords, notes=cmaj7, voicing="drop2",
                                    inversion="0")["notes"])[0]
        self.assertEqual([p % 12 for p in drop2], [7, 0, 4, 11])  # G under C E B
        for style in ("close", "open", "drop2", "drop3", "spread", "shell", "power"):
            with self.subTest(style=style):
                voiced = self.call(voice_chords, notes=_notes(self.PROGRESSION),
                                   voicing=style, bass="root")
                for chord, source in zip(_by_onset(voiced["notes"]), self.PROGRESSION):
                    self.assertEqual(chord[0] % 12, source[0] % 12)  # bass = root
                    self.assertLess(chord[0], chord[1])
        self.assertIn("error", json.loads(voice_chords(json.dumps(
            {"notes": cmaj7, "voicing": "nope"}))))

    def test_voicing_keeps_single_notes(self):
        notes = _notes([[60, 64, 67]]) + [{"pitch": 72, "startTime": 6, "duration": 1}]
        result = self.call(voice_chords, notes=notes, voicing="open")
        self.assertIn(72, [n["pitch"] for n in result["notes"] if n["startTime"] == 6])

    def test_chordify_roots(self):
        scale = [60, 62, 64, 65, 67, 69, 71]
        melody = [{"pitch": p, "startTime": i, "duration": 1} for i, p in enumerate(scale)]
        result = self.call(chordify, notes=melody, tonic="C", scale="major",
                           mode="root", size="seventh")
        self.assertEqual(result["symbols"],
                         ["Cmaj7", "Dm7", "Em7", "Fmaj7", "G7", "Am7", "Bm7b5"])
        sus = self.call(chordify, notes=melody[:3], tonic="C", scale="major",
                        mode="root", size="sus2")
        self.assertEqual(sus["symbols"], ["Csus2", "Dsus2", "Esus4"])  # no fake sus2 on E
        out = self.call(chordify, notes=[{"pitch": 61, "startTime": 0, "duration": 1}],
                        tonic="C", scale="major", mode="root", size="triad")
        self.assertEqual(sorted({p % 12 for p in [n["pitch"] for n in out["notes"]]}), [1, 8])

    def test_chordify_top(self):
        melody = [{"pitch": p, "startTime": i, "duration": 1, "velocity": 100}
                  for i, p in enumerate([72, 74, 76, 77])]
        result = self.call(chordify, notes=melody, tonic="C", scale="major",
                           mode="top", size="triad")
        for chord, top in zip(_by_onset(result["notes"]), [72, 74, 76, 77]):
            self.assertEqual(chord[-1], top)  # the melody stays on top
            self.assertEqual(len(chord), 3)
        self.assertEqual(result["symbols"][0], "C")


class Progressions(unittest.TestCase):
    def build(self, **params):
        base = {"tonic": "C", "mode": "major", "octave": 4, "beatsPerChord": 4}
        base.update(params)
        return json.loads(generate_progression(json.dumps(base)))

    def test_legacy_registers(self):
        result = self.build(tonic="A", mode="minor", numerals=["i", "VI"])
        self.assertEqual(_by_onset(result["notes"])[0], [69, 72, 76])

    def test_borrowed_and_secondary(self):
        result = self.build(numerals=["I", "V/V", "V7", "bVII", "iv", "IVmaj7", "viiø7"],
                            voicing="close")
        self.assertNotIn("error", result)
        self.assertEqual(result["chordNames"],
                         ["C", "D", "G7", "Bb", "Fm", "Fmaj7", "Bm7b5"])
        self.assertIn("error", self.build(numerals=["I", "IVV"], voicing="close"))
        self.assertIn("error", self.build(numerals=["I", "IX"], voicing="close"))

    def test_sizes(self):
        sevenths = self.build(numerals=["I", "ii", "V"], voicing="close", size="seventh")
        self.assertEqual(sevenths["chordNames"], ["Cmaj7", "Dm7", "G7"])
        triads = self.build(numerals=["Imaj7", "V9"], voicing="close", size="triad")
        self.assertEqual(triads["chordNames"], ["C", "G"])
        ninths = self.build(tonic="A", mode="minor", numerals=["i", "iv"],
                            voicing="drop2", size="ninth")
        self.assertEqual(ninths["chordNames"], ["Am9", "Dm9"])

    def test_rhythms(self):
        offbeat = self.build(numerals=["I"], voicing="close", rhythm="offbeat")
        self.assertEqual(sorted({n["startTime"] for n in offbeat["notes"]}),
                         [0.5, 1.5, 2.5, 3.5])
        push = self.build(numerals=["I", "IV"], voicing="close", rhythm="push")
        self.assertEqual(sorted({n["startTime"] for n in push["notes"]}), [0.0, 3.5])
        self.assertEqual(push["length"], 8)
        bass = self.build(numerals=["I", "IV"], voicing="close", bass=True)
        lows = [min(c) for c in _by_onset(bass["notes"])]
        self.assertEqual([p % 12 for p in lows], [0, 5])
        self.assertTrue(all(p < 48 for p in lows))
        self.assertIn("error", self.build(numerals=["I"], voicing="close", rhythm="polka"))

    def test_symbols_shaped(self):
        result = json.loads(generate_from_symbols(json.dumps({
            "symbols": "Am7 D7 Gmaj7 C/E", "voicing": "close", "rhythm": "sustain",
        })))
        self.assertEqual(result["chordNames"], ["Am7", "D7", "Gmaj7", "C"])
        last = _by_onset(result["notes"])[-1]
        self.assertEqual(last[0] % 12, 4)  # slash bass: E under C


class Groove(unittest.TestCase):
    CHORD = [{"pitch": p, "startTime": 0, "duration": 2, "velocity": 100} for p in (60, 64, 67)]

    def call(self, fn, **payload):
        result = json.loads(fn(json.dumps(payload)))
        self.assertNotIn("error", result, result.get("error"))
        return result

    def pitches(self, result):
        return [n["pitch"] for n in sorted(result["notes"], key=lambda n: n["startTime"])]

    def test_arp_legacy_defaults(self):
        result = self.call(arpeggiate, notes=self.CHORD, style="up", rate=0.25)
        self.assertEqual(self.pitches(result)[:4], [60, 64, 67, 60])
        self.assertEqual(len(result["notes"]), 8)

    def test_arp_patterns(self):
        expect = {
            "down": [67, 64, 60, 67],
            "updown": [60, 64, 67, 64],
            "downup": [67, 64, 60, 64],
            "converge": [60, 67, 64, 60],
            "thumb": [60, 64, 60, 67],
            "pinky": [60, 67, 64, 67],
        }
        for style, first in expect.items():
            with self.subTest(style=style):
                result = self.call(arpeggiate, notes=self.CHORD, style=style, rate=0.25)
                self.assertEqual(self.pitches(result)[:4], first)
        two = self.call(arpeggiate, notes=self.CHORD, style="up", rate=0.25, octaves=2)
        self.assertEqual(self.pitches(two)[:6], [60, 64, 67, 72, 76, 79])
        chord = self.call(arpeggiate, notes=self.CHORD, style="chord", rate=0.5)
        self.assertEqual(len(chord["notes"]), 12)
        rand = self.call(arpeggiate, notes=self.CHORD, style="random", rate=0.25, seed=7)
        self.assertEqual(sorted(set(self.pitches(rand))), [60, 64, 67])
        self.assertIn("error", json.loads(arpeggiate(json.dumps(
            {"notes": self.CHORD, "style": "sideways"}))))

    def test_arp_swing_gate_accent(self):
        result = self.call(arpeggiate, notes=self.CHORD, style="up", rate=0.25,
                           swing=1, gate=0.5, accent=True)
        starts = sorted({n["startTime"] for n in result["notes"]})
        self.assertAlmostEqual(starts[1], 0.25 + 0.25 / 3, places=5)
        self.assertEqual(starts[2], 0.5)
        self.assertTrue(all(n["duration"] <= 0.125 + 1e-9 for n in result["notes"]))
        on_beat = [n["velocity"] for n in result["notes"] if n["startTime"] in (0, 1)]
        self.assertTrue(all(v == 112 for v in on_beat))

    def test_strum(self):
        result = self.call(strum, notes=self.CHORD, direction="down", speed=25, bpm=120)
        by_pitch = {n["pitch"]: n for n in result["notes"]}
        self.assertEqual(by_pitch[60]["startTime"], 0)
        self.assertAlmostEqual(by_pitch[64]["startTime"], 0.05)
        self.assertAlmostEqual(by_pitch[67]["startTime"] + by_pitch[67]["duration"], 2)
        up = self.call(strum, notes=self.CHORD, direction="up", speed=25, bpm=120)
        self.assertEqual(min(up["notes"], key=lambda n: n["startTime"])["pitch"], 67)
        mono = [{"pitch": 60, "startTime": 0, "duration": 1}]
        self.assertIn("error", json.loads(strum(json.dumps({"notes": mono}))))

    def test_humanize(self):
        loose = [{"pitch": 60, "startTime": i * 0.5 + 0.03, "duration": 0.25, "velocity": 100}
                 for i in range(8)]
        tight = self.call(humanize, notes=loose, grid=0.5, strength=1, bpm=120)
        self.assertEqual([n["startTime"] for n in tight["notes"]], [i * 0.5 for i in range(8)])
        swung = self.call(humanize, notes=loose, grid=0.5, strength=1, swing=1, bpm=120)
        self.assertAlmostEqual(swung["notes"][1]["startTime"], 0.5 + 0.5 / 3, places=5)
        drift = self.call(humanize, notes=loose, timing=10, velocity=12, liveVelocity=20,
                          bpm=120, seed=3)
        for before, after in zip(loose, drift["notes"]):
            self.assertLessEqual(abs(after["startTime"] - before["startTime"]), 0.02 + 1e-9)
            self.assertLessEqual(abs(after["velocity"] - 100), 12)
            self.assertEqual(after["duration"], 0.25)
            self.assertEqual(after["velocityDeviation"], 20)
        again = self.call(humanize, notes=loose, timing=10, velocity=12, bpm=120, seed=3)
        self.assertEqual([n["startTime"] for n in again["notes"]],
                         [n["startTime"] for n in drift["notes"]])


class Euclid(unittest.TestCase):
    def test_bjorklund(self):
        def text(h, s, r=0):
            return "".join("x" if v else "." for v in euclid(h, s, r))
        self.assertEqual(text(3, 8), "x..x..x.")       # tresillo
        self.assertEqual(text(5, 8), "x.xx.xx.")       # cinquillo
        self.assertEqual(text(4, 16), "x...x...x...x...")
        self.assertEqual(text(7, 16), "x..x.x.x..x.x.x.")
        self.assertEqual(text(5, 12), "x..x.x..x.x.")
        self.assertEqual(text(4, 16, 2), "..x...x...x...x.")  # offbeat hats
        self.assertEqual(text(0, 4), "....")
        self.assertEqual(text(4, 4), "xxxx")
        for h in range(0, 17):
            self.assertEqual(sum(euclid(h, 16)), h)

    def test_drum_lanes(self):
        result = json.loads(generate_euclidean(json.dumps({
            "mode": "drums", "bars": 2, "lanes": [
                {"pitch": 36, "hits": 4, "steps": 16},
                {"pitch": 39, "hits": 2, "steps": 16, "rotation": 4},
                {"pitch": 42, "hits": 0, "steps": 16},
            ]})))
        self.assertEqual(result["length"], 8)
        claps = sorted(n["startTime"] for n in result["notes"] if n["pitch"] == 39)
        self.assertEqual(claps, [1.0, 3.0, 5.0, 7.0])
        self.assertEqual(len([n for n in result["notes"] if n["pitch"] == 36]), 8)
        self.assertIn("error", json.loads(generate_euclidean(json.dumps({
            "mode": "drums", "lanes": [{"pitch": 36, "hits": 9, "steps": 8}]}))))
        self.assertIn("error", json.loads(generate_euclidean(json.dumps({
            "mode": "drums", "lanes": [{"pitch": 36, "hits": 0, "steps": 8}]}))))

    def test_pitched(self):
        result = json.loads(generate_euclidean(json.dumps({
            "mode": "pitched", "tonic": "A", "scale": "minor", "hits": 3, "steps": 8,
            "pitches": "triad", "octave": 2})))
        self.assertEqual([n["pitch"] for n in result["notes"]][:4], [45, 48, 52, 48])
        self.assertEqual([n["startTime"] for n in result["notes"]][:3], [0.0, 0.75, 1.5])


suite = unittest.TestSuite()
for case in (ReleaseRegression, Voicings, Progressions, Groove, Euclid):
    suite.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(case))
result = unittest.TextTestRunner(verbosity=2).run(suite)
if not result.wasSuccessful():
    raise AssertionError("Pyodide regression tests failed")
