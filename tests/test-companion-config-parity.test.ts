/**
 * Cross-repo constant parity tripwire: the reader companion charges credits and
 * enforces character limits using constants that are duplicated (by design —
 * the two repos cannot share a package) in:
 *
 *   - TWISTLOOM_BACKEND/src/config/credits.ts   ↔  TWISTLOOM_WEB/src/lib/config/credits.ts
 *   - TWISTLOOM_BACKEND/src/config/story.ts     ↔  TWISTLOOM_WEB/src/lib/config/story.ts
 *
 * If either side drifts (cost change, limit change) the client would quote a
 * price / enforce a length the server rejects. This test parses BOTH files and
 * fails on any mismatch.
 *
 * The web checkout is located via `TWISTLOOM_WEB_ROOT` or as a sibling
 * directory (`../Twistloom-web`). When neither exists (standalone backend
 * checkout/CI), the parity assertions are skipped rather than failed.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const backendRoot = resolve(import.meta.dir, '..');

const webRootCandidates = [
  process.env['TWISTLOOM_WEB_ROOT'],
  resolve(backendRoot, '..', 'Twistloom-web'),
].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);

const webRoot = webRootCandidates.find((candidate) => existsSync(resolve(candidate, 'package.json')));

function read(relativePath: string, root: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

function extractNumber(source: string, pattern: RegExp, label: string): number {
  const match = pattern.exec(source);
  if (!match) {
    throw new Error(`Could not locate ${label} — constant renamed or restructured?`);
  }
  return Number(match[1]);
}

function extractPair(
  pattern: RegExp,
  label: string
): { backend: number; web: number | null } {
  const backendSource = read('src/config/credits.ts', backendRoot);
  const webSource = webRoot ? read('src/lib/config/credits.ts', webRoot) : null;
  return {
    backend: extractNumber(backendSource, pattern, `backend ${label}`),
    web: webSource === null ? null : extractNumber(webSource, pattern, `web ${label}`),
  };
}

describe('companion constant parity (backend ↔ web)', () => {
  if (!webRoot) {
    it('is skipped when the Twistloom-web checkout is not a sibling directory', () => {
      expect(true).toBe(true);
    });
    return;
  }

  it('charges the same credit cost for COMPANION_ASK', () => {
    const { backend, web } = extractPair(/COMPANION_ASK:\s*(\d+)/, 'COMPANION_ASK credit cost');
    expect(web).toBe(backend);
  });

  it('agrees on companion question character limits', () => {
    const backendStory = read('src/config/story.ts', backendRoot);
    const webStory = read('src/lib/config/story.ts', webRoot);

    const constants = [
      'COMPANION_ASK_MIN_CHARS',
      'COMPANION_ASK_MAX_CHARS',
      'COMPANION_ASK_MAX_CHARS_VIP',
    ] as const;

    for (const name of constants) {
      const pattern = new RegExp(`export const ${name}\\s*=\\s*(\\d+)`);
      const backendValue = extractNumber(backendStory, pattern, `backend ${name}`);
      const webValue = extractNumber(webStory, pattern, `web ${name}`);
      expect({ name, value: webValue }).toEqual({ name, value: backendValue });
    }
  });
});
