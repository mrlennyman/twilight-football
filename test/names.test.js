const test = require('node:test');
const assert = require('node:assert/strict');
const { firstNameLastInitial } = require('../src/lib/queries');

test('firstNameLastInitial: public roster shows first name(s) + last initial only', () => {
  const cases = [
    ['Te Rangi H.', 'Te Rangi H.'],
    ['Te Rangi H', 'Te Rangi H.'],
    ['Jack Brown', 'Jack B.'],
    ['Mia', 'Mia'],
    ['jo k', 'jo K.'],
    ['  Jack   Brown  ', 'Jack B.'],
    ['Te Rangi Hōhepa-Smith', 'Te H.'], // full surname never shown, even if it can't be shortened nicely
    ['Mia Ōtāne', 'Mia Ō.'],
    ['Sam \u{1D56C}ox', 'Sam \u{1D56C}.'], // initial taken by code point, not a broken surrogate half
    ['Léa É', 'Léa É.'],
  ];
  for (const [input, expected] of cases) assert.equal(firstNameLastInitial(input), expected, input);
});

test('no result ever contains a full surname of 2+ letters', () => {
  for (const name of ['Jack Brown', 'Te Rangi Hohepa', 'Anna-Marie O\'Neill', 'Mia Chen Wei']) {
    const out = firstNameLastInitial(name);
    assert.ok(/ \p{L}\.$/u.test(out), `${name} -> ${out}`);
  }
});
