import { describe, expect, it } from 'bun:test';
import {
  intentJaccardSimilarity,
  normalizeForIntent,
  tokenizeForIntent,
  wordJaccardSimilarity,
} from '../src/utils/search.js';

describe('tokenizeForIntent (P17 — intent normalization)', () => {
  it('strips English interrogative/auxiliary framing', () => {
    expect(tokenizeForIntent('Why did Marcus take the key?')).toEqual([
      'marcus',
      'take',
      'key',
    ]);
    expect(tokenizeForIntent('What caused Marcus to leave?')).toEqual([
      'caused',
      'marcus',
      'leave',
    ]);
  });

  it('strips Indonesian framing and detaches the -kah question particle', () => {
    expect(tokenizeForIntent('Kenapa Marcus mengambil kunci?')).toEqual([
      'marcus',
      'mengambil',
      'kunci',
    ]);
    expect(tokenizeForIntent('Apakah Marcus mengambil kunci?')).toEqual([
      'marcus',
      'mengambil',
      'kunci',
    ]);
    expect(tokenizeForIntent('Apakah benar Marcus pergi?')).toEqual([
      'benar',
      'marcus',
      'pergi',
    ]);
  });

  it('never empties a query — floor guards keep the framing-stripped form', () => {
    expect(tokenizeForIntent('Why?')).toEqual(['why']);
    expect(tokenizeForIntent('Kenapa?')).toEqual(['kenapa']);
    expect(tokenizeForIntent('Where is Marcus?')).toEqual(['marcus']);
    expect(tokenizeForIntent('???')).toEqual([]);
    expect(normalizeForIntent('???')).toBe('');
  });

  it('preserves negation so opposite claims never collapse to one token set', () => {
    expect(tokenizeForIntent("Why didn't Marcus kill Elena?")).toEqual([
      'didn',
      't',
      'marcus',
      'kill',
      'elena',
    ]);
    expect(
      intentJaccardSimilarity(
        "Why didn't Marcus kill Elena?",
        'Why did Marcus kill Elena?',
      ),
    ).toBeLessThan(0.8);
  });

  it('leaves Indonesian content words ending in -lah/-tah untouched', () => {
    expect(tokenizeForIntent('Apa yang salah di sini?')).toEqual([
      'salah',
      'sini',
    ]);
    expect(tokenizeForIntent('Wajah Marcus terluka?')).toEqual([
      'wajah',
      'marcus',
      'terluka',
    ]);
  });
});

describe('intentJaccardSimilarity (P17 — max(raw, normalized))', () => {
  it('boosts recall for framing-word paraphrases', () => {
    const raw = wordJaccardSimilarity(
      'What could have caused Marcus to leave?',
      'Why did Marcus leave?',
    );
    const intent = intentJaccardSimilarity(
      'What could have caused Marcus to leave?',
      'Why did Marcus leave?',
    );

    expect(raw).toBeLessThan(0.25);
    expect(intent).toBeGreaterThan(0.5);
    expect(intent).toBeGreaterThanOrEqual(raw);
  });

  it('matches the suggestion filter threshold (0.25) for paraphrased phrasing', () => {
    expect(
      intentJaccardSimilarity(
        'Kenapa Marcus mengambil kunci?',
        'Apakah Marcus mengambil kunci itu?',
      ),
    ).toBeGreaterThanOrEqual(0.25);
  });

  it('never lowers an already-passing raw score (no threshold retuning)', () => {
    const pairs: Array<[string, string]> = [
      ['Why did Marcus take the key?', 'Why did Marcus take the iron key?'],
      ['Who killed Elena?', 'Who killed Elena'],
      ['What is hidden in the crypt?', 'Apa yang tersembunyi di kripta?'],
      ['Did Marcus betray Elena?', 'Did Marcus betray Elena?'],
      ['', ''],
    ];

    for (const [a, b] of pairs) {
      expect(intentJaccardSimilarity(a, b)).toBeGreaterThanOrEqual(
        wordJaccardSimilarity(a, b),
      );
    }
  });

  it('keeps semantically different short questions below the 0.8 cache threshold', () => {
    expect(
      intentJaccardSimilarity(
        'Why is Marcus in the crypt?',
        'Why is Elena in the crypt?',
      ),
    ).toBeLessThan(0.8);
    expect(
      intentJaccardSimilarity(
        'Who killed Elena?',
        'Who did Elena kill?',
      ),
    ).toBeLessThan(0.8);
  });
});
