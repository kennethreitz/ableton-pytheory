// Unit tests for the pure TypeScript helpers (run with tsx, no Live needed).
import assert from "node:assert/strict";
import { matchScale, spellTonic } from "../src/keys.ts";

const options = {
  tonics: ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
    "Db", "Eb", "Gb", "Ab", "Bb"],
  scales: ["major", "minor", "harmonic minor", "ionian", "dorian", "phrygian",
    "lydian", "mixolydian", "aeolian", "locrian"],
  scaleIntervals: {
    major: [0, 2, 4, 5, 7, 9, 11], ionian: [0, 2, 4, 5, 7, 9, 11],
    minor: [0, 2, 3, 5, 7, 8, 10], aeolian: [0, 2, 3, 5, 7, 8, 10],
    "harmonic minor": [0, 2, 3, 5, 7, 8, 11],
    dorian: [0, 2, 3, 5, 7, 9, 10], phrygian: [0, 1, 3, 5, 7, 8, 10],
    lydian: [0, 2, 4, 6, 7, 9, 11], mixolydian: [0, 2, 4, 5, 7, 9, 10],
    locrian: [0, 1, 3, 5, 6, 8, 10],
  },
};

// Exact names and exact interval matches.
assert.equal(matchScale("Major", [0, 2, 4, 5, 7, 9, 11], options), "major");
assert.equal(matchScale("Minor", [0, 2, 3, 5, 7, 8, 10], options), "minor");
assert.equal(matchScale("Dorian", [0, 2, 3, 5, 7, 9, 10], options), "dorian");
assert.equal(matchScale("Mixolydian", [0, 2, 4, 5, 7, 9, 10], options), "mixolydian");
assert.equal(matchScale("Harmonic Minor", [0, 2, 3, 5, 7, 8, 11], options), "harmonic minor");
// Live-only names resolve by intervals.
assert.equal(matchScale("Minor Pentatonic", [0, 3, 5, 7, 10], options), "minor");
assert.equal(matchScale("Major Pentatonic", [0, 2, 4, 7, 9], options), "major");
assert.equal(matchScale("Phrygian Dominant", [0, 1, 4, 5, 7, 8, 10], options), "major");
assert.equal(matchScale("Blues", [0, 3, 5, 6, 7, 10], options), "minor");
// No intervals (older hosts): by name.
assert.equal(matchScale("Super Minor", undefined, options), "minor");

// Spelling follows the scale.
assert.equal(spellTonic(10, "major", options), "Bb");
assert.equal(spellTonic(1, "major", options), "Db");
assert.equal(spellTonic(1, "minor", options), "C#");
assert.equal(spellTonic(8, "minor", options), "G#");
assert.equal(spellTonic(3, "dorian", options), "Eb");
assert.equal(spellTonic(6, "major", options), "F#");

console.log("keys helpers passed");
