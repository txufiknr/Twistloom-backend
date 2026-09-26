import { describe, expect, test } from "bun:test";
import { createJsonTextFieldExtractor } from "../src/utils/ai-parser.js";

/** Push an array of deltas and concatenate the decoded increments. */
function pushAll(deltas: string[]): { emitted: string; ex: ReturnType<typeof createJsonTextFieldExtractor> } {
  const ex = createJsonTextFieldExtractor("text");
  const emitted = deltas.map((d) => ex.push(d)).join("");
  return { emitted, ex };
}

describe("createJsonTextFieldExtractor", () => {
  test("decodes the growing text field of a streamed JSON object", () => {
    const { emitted } = pushAll([
      '{"te',
      'xt": "Hel',
      'lo ',
      'world", "iss',
      'ues": []}',
    ]);
    expect(emitted).toBe("Hello world");
  });

  test("stops at the field's closing quote and ignores sibling fields", () => {
    const ex = createJsonTextFieldExtractor("text");
    let out = "";
    out += ex.push('{"text": "abc", "issues": [{"expected": "X"}]}');
    expect(out).toBe("abc");
    // Anything pushed after completion stays silent.
    expect(ex.push(' more')).toBe("");
  });

  test("holds a partial escape sequence until it completes", () => {
    const ex = createJsonTextFieldExtractor("text");
    let out = "";
    out += ex.push('{"text": "line1\\');
    expect(out).toBe("line1");
    out += ex.push('nline2\\u004');
    expect(out).toBe("line1\nline2");
    // \u004 + 1Q completes the \u0041 ('A') escape, then emits Q.
    out += ex.push('1Q"}');
    expect(out).toBe("line1\nline2AQ");
  });

  test("decodes common escapes and unicode", () => {
    const { emitted } = pushAll(['{"text": "a\\"b\\\\c\\td\\u00e9"}']);
    expect(emitted).toBe('a"b\\c\td\u00e9');
  });

  test("passes non-JSON output through verbatim (raw mode)", () => {
    const { emitted } = pushAll(["Once upon ", "a time."]);
    expect(emitted).toBe("Once upon a time.");
  });

  test("skips a leading markdown fence before classifying", () => {
    const { emitted } = pushAll(["```json\n", '{"text": "gated"}']);
    expect(emitted).toBe("gated");
  });

  test("holds whitespace-only input until classification is possible", () => {
    const ex = createJsonTextFieldExtractor("text");
    expect(ex.push("   ")).toBe("");
    expect(ex.push('{"text": "now"}')).toBe("now");
  });

  test("reset discards prior state so a provider retry previews cleanly", () => {
    const ex = createJsonTextFieldExtractor("text");
    let out = ex.push('{"text": "partial');
    expect(out).toBe("partial");
    ex.reset();
    out = ex.push('{"text": "fresh"}');
    expect(out).toBe("fresh");
  });

  test("raw-mode text arriving after reset is classified again", () => {
    const ex = createJsonTextFieldExtractor("text");
    expect(ex.push('{"text": "x"')).toBe("x");
    ex.reset();
    expect(ex.push("plain prose")).toBe("plain prose");
  });
});
