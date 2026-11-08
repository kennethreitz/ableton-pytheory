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


suite = unittest.defaultTestLoader.loadTestsFromTestCase(ReleaseRegression)
result = unittest.TextTestRunner(verbosity=2).run(suite)
if not result.wasSuccessful():
    raise AssertionError("Pyodide regression tests failed")
