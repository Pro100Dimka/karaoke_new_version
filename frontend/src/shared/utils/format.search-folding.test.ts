import { expect, it } from 'vitest';
import { normalizeSearch } from './format';

// Expected values follow the backend's Unicode default casefold, not locale casing.
it.each([
  ['Straße', 'strasse'],
  ['STRAẞE', 'strasse'],
  ['ΟΣ', 'οσ'],
  ['οσ', 'οσ'],
  ['ος', 'οσ'],
  ['Ꭰꭰ', 'ᎠᎠ'],
  ['İIıi', 'i\u0307iıi'],
  ['ᾲ', 'ὰι'],
  ['\u{10400}', '\u{10428}'],
  ['ＳＴＲＡＳＳＥ', 'strasse'],
  ['oﬃce', 'office'],
  ['Cafe\u0301', 'café'],
])(
  'folds %s like the backend after compatibility normalization',
  (input, expected) => {
    expect(normalizeSearch(input)).toBe(expected);
  },
);

it('keeps dotless i distinct from ASCII i', () => {
  expect(normalizeSearch('ı')).not.toBe(normalizeSearch('i'));
});

it('does not let Greek word-final casing change substring matches', () => {
  expect(normalizeSearch('ΟΣΑ')).toContain(normalizeSearch('ΟΣ'));
});
