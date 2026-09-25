/**
 * Local Whisper hallucination filter — gate C (text sanitize).
 *
 * Covers the seven cases from HANDOFF_marinara_stt_filter.md §7 plus the
 * normalization contract, the Transformers.js chunk adapter, the fallback
 * splitter, and the phrase-file loader (seeding, hot reload, bad JSON).
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  compileSttPhraseList,
  createSttPhraseLoader,
  normalizeSttText,
  sanitizeSttSegments,
  splitSttTextIntoSegments,
  sttSegmentsFromAsrOutput,
} = await import("../../packages/server/src/services/sidecar/stt-sanitize.js");
const { readSttConfig, STT_DEFAULT_CONFIG } = await import("../../packages/server/src/services/sidecar/stt-config.js");

const bundledPath = new URL("../../packages/server/src/assets/stt-hallucination-phrases.json", import.meta.url);
const bundledRaw = JSON.parse(await readFile(bundledPath, "utf-8"));
const phrases = compileSttPhraseList(bundledRaw, (pattern, error) => {
  throw new Error(`bundled regex ${pattern} failed to compile: ${String(error)}`);
});
const options = {
  repeatThreshold: STT_DEFAULT_CONFIG.repeatThreshold,
  tailGapSeconds: STT_DEFAULT_CONFIG.tailGapSeconds,
  tailMaxChars: STT_DEFAULT_CONFIG.tailMaxChars,
};
const texts = (list: string[]) => list.map((text) => ({ text }));

// ── normalization contract ─────────────────────────────────────────────
assert.equal(normalizeSttText(" I'm sorry. "), "imsorry");
assert.equal(normalizeSttText("시청해 주셔서 감사합니다."), "시청해주셔서감사합니다");
assert.equal(normalizeSttText("Thank you!! 👍"), "thankyou");
assert.equal(normalizeSttText("한글"), "한글", "Hangul syllables must not be decomposed into jamo");
assert.equal(normalizeSttText("..."), "");

// ── §7 case 1: known phrase repeated → all three dropped by rule 1 ────
{
  const result = sanitizeSttSegments(
    texts(["안녕 잘 지냈어", "I'm sorry", "I'm sorry", "I'm sorry"]),
    phrases,
    options,
  );
  assert.equal(result.text, "안녕 잘 지냈어");
  assert.deepEqual(
    result.dropped.map((item) => item.rule),
    [1, 1, 1],
  );
}

// ── §7 case 2: full erasure returns the empty string ─────────────────
{
  const result = sanitizeSttSegments(texts(["시청해 주셔서 감사합니다."]), phrases, options);
  assert.equal(result.text, "");
  assert.equal(result.dropped.length, 1);
  assert.equal(result.dropped[0]?.rule, 1);
}

// ── §7 case 3: partial match must NOT drop a real sentence ───────────
{
  const result = sanitizeSttSegments(texts(["오늘 도와줘서 정말 감사합니다"]), phrases, options);
  assert.equal(result.text, "오늘 도와줘서 정말 감사합니다");
  assert.equal(result.dropped.length, 0);
}

// ── §7 case 4: repetition collapse keeps the first occurrence ─────────
{
  const result = sanitizeSttSegments(texts(["아니", "아니", "아니", "아니", "그게 아니라"]), phrases, options);
  assert.equal(result.text, "아니 그게 아니라");
  assert.deepEqual(
    result.dropped.map((item) => item.rule),
    [2, 2, 2],
  );
  // Below the threshold nothing is touched.
  const twice = sanitizeSttSegments(texts(["아니", "아니", "그게 아니라"]), phrases, options);
  assert.equal(twice.text, "아니 아니 그게 아니라");
  assert.equal(twice.dropped.length, 0);
}

// ── §7 case 5: tail rule needs a long gap ─────────────────────────────
{
  const farTail = [
    { text: "밥 먹었어?", start: 0, end: 1.2 },
    { text: "죄송합니다", start: 4.2, end: 5.0 },
  ];
  const result = sanitizeSttSegments(farTail, phrases, options);
  assert.equal(result.text, "밥 먹었어?");
  assert.deepEqual(result.dropped, [{ rule: 3, text: "죄송합니다" }]);

  const nearTail = [
    { text: "밥 먹었어?", start: 0, end: 1.2 },
    { text: "죄송합니다", start: 1.5, end: 2.3 },
  ];
  const kept = sanitizeSttSegments(nearTail, phrases, options);
  assert.equal(kept.text, "밥 먹었어? 죄송합니다");
  assert.equal(kept.dropped.length, 0);

  // A long tail segment is not a hallucination candidate even after a gap.
  const longTail = [
    { text: "밥 먹었어?", start: 0, end: 1.2 },
    { text: "아까 늦게 와서 죄송합니다 정말로요", start: 4.2, end: 6.0 },
  ];
  assert.equal(sanitizeSttSegments(longTail, phrases, options).dropped.length, 0);

  // Whisper reports null for an unterminated previous chunk: no gap → rule 3 stays off.
  const nullEnd = [
    { text: "밥 먹었어?", start: 0, end: null },
    { text: "죄송합니다", start: 4.2, end: 5.0 },
  ];
  assert.equal(sanitizeSttSegments(nullEnd, phrases, options).dropped.length, 0);
}

// ── §7 case 6: without timestamps rule 3 never fires ──────────────────
{
  const result = sanitizeSttSegments(texts(["밥 먹었어?", "죄송합니다"]), phrases, options);
  assert.equal(result.text, "밥 먹었어? 죄송합니다");
  assert.equal(result.dropped.length, 0);
}

// ── §7 case 7: STT_SANITIZE=off is honoured by the config reader ──────
{
  const config = readSttConfig({ STT_SANITIZE: "off" });
  assert.equal(config.sanitize, false);
  assert.equal(readSttConfig({ STT_SANITIZE: "0" }).sanitize, false);
  assert.equal(readSttConfig({}).sanitize, true);
  assert.equal(readSttConfig({ STT_SANITIZE: "garbage" }).sanitize, true, "unknown values fall back to default");
  assert.equal(readSttConfig({}).language, "ko");
  assert.equal(readSttConfig({ STT_LANGUAGE: "" }).language, "", "empty language = auto-detect");
  assert.equal(readSttConfig({ STT_LANGUAGE: " EN " }).language, "en");
  assert.equal(readSttConfig({ STT_REPEAT_THRESHOLD: "1" }).repeatThreshold, 3, "threshold below 2 is rejected");
  assert.equal(readSttConfig({ STT_REPEAT_THRESHOLD: "5" }).repeatThreshold, 5);
  assert.equal(readSttConfig({ STT_TRIM_THRESHOLD_DB: "abc" }).trimThresholdDb, -45);
  assert.equal(readSttConfig({ STT_TAIL_GAP_S: "2.5" }).tailGapSeconds, 2.5);
  assert.equal(readSttConfig({ STT_PHRASES_PATH: "  " }).phrasesPath, null);
  assert.equal(readSttConfig({ STT_PHRASES_PATH: "/tmp/x.json" }).phrasesPath, "/tmp/x.json");
}

// ── regex entries are whole-segment matches ───────────────────────────
{
  assert.equal(sanitizeSttSegments(texts(["MBC 뉴스 김민수입니다."]), phrases, options).text, "");
  assert.equal(sanitizeSttSegments(texts(["I'm sorry. I'm sorry. I'm sorry."]), phrases, options).text, "");
  assert.equal(sanitizeSttSegments(texts(["Thank you thank you"]), phrases, options).text, "");
  // Not anchored-only: real content that merely contains a pattern survives.
  assert.equal(
    sanitizeSttSegments(texts(["어제 MBC 뉴스 김민수입니다 라는 멘트를 들었어"]), phrases, options).dropped.length,
    0,
  );
}

// ── empty / punctuation-only segments vanish without being counted ────
{
  const result = sanitizeSttSegments(texts(["...", "안녕", " "]), phrases, options);
  assert.equal(result.text, "안녕");
  assert.equal(result.dropped.length, 0);
}

// ── Transformers.js chunk adapter and fallback splitter ───────────────
{
  const output = {
    text: " 안녕 잘 지냈어 I'm sorry.",
    chunks: [
      { timestamp: [0, 1.4], text: " 안녕 잘 지냈어" },
      { timestamp: [3.2, null], text: " I'm sorry." },
    ],
  };
  const segments = sttSegmentsFromAsrOutput(output);
  assert.ok(segments);
  assert.deepEqual(segments, [
    { text: " 안녕 잘 지냈어", start: 0, end: 1.4 },
    { text: " I'm sorry.", start: 3.2, end: null },
  ]);
  assert.equal(sttSegmentsFromAsrOutput({ text: "no chunks" }), null);
  assert.equal(sttSegmentsFromAsrOutput({ text: "", chunks: [] }), null);
  assert.equal(sttSegmentsFromAsrOutput("string"), null);

  assert.deepEqual(splitSttTextIntoSegments("밥 먹었어? 응. 그리고\n감사합니다"), [
    { text: "밥 먹었어?" },
    { text: "응." },
    { text: "그리고" },
    { text: "감사합니다" },
  ]);
  assert.deepEqual(splitSttTextIntoSegments("   "), []);
}

// ── compileSttPhraseList tolerates sloppy input ───────────────────────
{
  const invalid: string[] = [];
  const compiled = compileSttPhraseList(
    { exact: ["Thank You!", "", 42, " 감사 합니다 "], regex: ["(unclosed", "^ok$"], tailSuspects: ["Bye."] },
    (pattern) => invalid.push(pattern),
  );
  assert.deepEqual([...compiled.exact].sort(), ["thankyou", "감사합니다"]);
  assert.deepEqual(invalid, ["(unclosed"]);
  assert.equal(compiled.regex.length, 1);
  assert.deepEqual(compiled.tailSuspects, ["bye"]);
  const empty = compileSttPhraseList(null);
  assert.equal(empty.exact.size, 0);
  assert.equal(sanitizeSttSegments(texts(["thank you"]), empty, options).text, "thank you");
}

// ── phrase-file loader: seed, hot reload on mtime change, keep last good on bad JSON ─
{
  const dir = await mkdtemp(join(tmpdir(), "stt-sanitize-regression-"));
  try {
    const path = join(dir, "nested", "phrases.json");
    const warnings: string[] = [];
    const loader = createSttPhraseLoader(path, {
      seedFrom: bundledPath.pathname,
      warn: (message) => warnings.push(message),
    });
    assert.ok(loader.get().exact.has("imsorry"), "seeded from the bundled default");
    assert.deepEqual(warnings, []);

    await writeFile(path, JSON.stringify({ exact: ["custom phrase"], regex: [], tailSuspects: [] }), "utf-8");
    const future = new Date(Date.now() + 5_000);
    await utimes(path, future, future);
    assert.ok(loader.get().exact.has("customphrase"), "reloaded after the file changed");
    assert.ok(!loader.get().exact.has("imsorry"));

    await writeFile(path, "{ not json", "utf-8");
    const later = new Date(Date.now() + 10_000);
    await utimes(path, later, later);
    assert.ok(loader.get().exact.has("customphrase"), "bad JSON keeps the previous list");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /Could not parse/);

    const missing = createSttPhraseLoader(join(dir, "missing.json"), { warn: (message) => warnings.push(message) });
    assert.equal(missing.get().exact.size, 0);
    missing.get();
    assert.equal(warnings.length, 2, "missing-file warning is emitted once, not per call");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log("stt-sanitize regression passed");
