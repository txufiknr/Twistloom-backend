import { describe, expect, it } from 'bun:test';
import {
  BOOK_LANGUAGES,
  BOOK_AGE_RANGES,
  BOOK_GENDERS,
  BOOK_MODES,
} from '../src/config/catalog.js';
import { sanitizeActionHints } from '../src/services/book.js';

describe('F-13 Catalogue Facet SSOT', () => {
  it('publishes exactly the 15 canonical catalogue languages matching web and Flutter enums', () => {
    expect(BOOK_LANGUAGES).toEqual([
      'en', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'zh',
      'ja', 'ko', 'ar', 'hi', 'id', 'th', 'vi'
    ]);
    expect(BOOK_LANGUAGES.length).toBe(15);
  });

  it('publishes the 6 canonical age range buckets matching web catalogue spans', () => {
    expect(BOOK_AGE_RANGES).toEqual([
      '13-15', '16-18', '19-21', '22-25', '26-40', '41-65'
    ]);
  });

  it('publishes gender and mode options for explore', () => {
    expect(BOOK_GENDERS).toEqual(['male', 'female']);
    expect(BOOK_MODES).toEqual(['novel', 'interactive', 'multiverse']);
  });
});

describe('F-22 Server-Side Action Hint Redaction', () => {
  const secretHint = 'A trap is set behind the hidden bookcase';
  const actions = [
    {
      text: 'Open bookcase',
      type: 'action',
      hint: { text: secretHint, type: 'mystery' },
    },
    {
      text: 'Examine desk',
      type: 'action',
      hint: { text: 'Only old papers here', type: 'discovery' },
    },
    {
      text: 'Wait quietly',
      type: 'action',
    },
  ];

  it('scrambles unpurchased hint text with letter substitution preserving words and spaces for non-authors', () => {
    const shownActionHint: string[] = []; // No hints purchased
    const isAuthor = false;

    const sanitizedActions = sanitizeActionHints(actions as any, shownActionHint, isAuthor);

    // Secret text is NOT leaked
    expect(sanitizedActions[0].hint?.text).not.toContain('trap');
    expect(sanitizedActions[0].hint?.text).not.toContain('bookcase');

    // Length, casing structure, and spaces are preserved
    expect(sanitizedActions[0].hint?.text?.length).toBe(secretHint.length);
    expect(sanitizedActions[0].hint?.text?.split(' ').length).toBe(secretHint.split(' ').length);

    // Sentence-like scrambled letters (no blocks)
    expect(/[a-zA-Z]/.test(sanitizedActions[0].hint?.text ?? '')).toBe(true);
    expect(sanitizedActions[0].hint?.text).not.toContain('█');
  });

  it('delivers the plain secret text when the hint was purchased', () => {
    const shownActionHint = ['Open bookcase'];
    const isAuthor = false;

    const sanitizedActions = sanitizeActionHints(actions as any, shownActionHint, isAuthor);

    expect(sanitizedActions[0].hint?.text).toBe(secretHint);
    // Unpurchased action on the same page remains masked
    expect(sanitizedActions[1].hint?.text).not.toContain('papers');
  });

  it('delivers the plain secret text to the author of the book', () => {
    const shownActionHint: string[] = []; // Author hasn't "purchased" it
    const isAuthor = true;

    const sanitizedActions = sanitizeActionHints(actions as any, shownActionHint, isAuthor);

    expect(sanitizedActions[0].hint?.text).toBe(secretHint);
    expect(sanitizedActions[1].hint?.text).toBe('Only old papers here');
  });
});
