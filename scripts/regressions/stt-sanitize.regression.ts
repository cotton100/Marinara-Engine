/**
 * Local Whisper hallucination filter — gate C (text sanitize).
 *
 * Covers preservation of ordinary speech, targeted broadcast-phrase removal,
 * repetition collapse, custom rules, normalization, the Transformers.js chunk
 * adapter, fallback splitter, and phrase-file loading (seed, reload, bad JSON).
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

// ── ordinary ko/en/ja speech must survive, including a standalone reply ─
{
  const replies = [
    "네",
    "음",
    "끝",
    "감사합니다",
    "고맙습니다",
    "죄송합니다",
    "미안해요",
    "안녕",
    "자막",
    "I'm sorry",
    "sorry",
    "Thank you",
    "thanks",
    "okay",
    "hmm",
    "bye",
    "you",
    "subscribe",
    "I can't share that",
    "おやすみなさい",
    "ありがとうございました",
    "ありがとう",
    "字幕",
  ];
  for (const reply of replies) {
    const result = sanitizeSttSegments(texts([reply]), phrases, options);
    assert.equal(result.text, reply, `ordinary reply must survive: ${reply}`);
    assert.deepEqual(result.dropped, []);

    // A pause alone is not evidence that a polite closing was hallucinated.
    for (const start of [1.3, 4.2]) {
      const withGap = sanitizeSttSegments(
        [
          { text: "오늘 이야기해 줘서 좋았어", start: 0, end: 1.2 },
          { text: reply, start, end: start + 1 },
        ],
        phrases,
        options,
      );
      assert.equal(withGap.text, `오늘 이야기해 줘서 좋았어 ${reply}`);
      assert.deepEqual(withGap.dropped, []);
    }
  }
  assert.equal(sanitizeSttSegments(texts(replies), phrases, options).text, replies.join(" "));
}

// ── repeated apologies retain one meaningful occurrence ───────────────
{
  const result = sanitizeSttSegments(
    texts(["안녕 잘 지냈어", "I'm sorry", "I'm sorry", "I'm sorry"]),
    phrases,
    options,
  );
  assert.equal(result.text, "안녕 잘 지냈어 I'm sorry");
  assert.deepEqual(
    result.dropped.map((item) => item.rule),
    [2, 2],
  );
  assert.equal(
    sanitizeSttSegments(splitSttTextIntoSegments("I'm sorry. I'm sorry. I'm sorry."), phrases, options).text,
    "I'm sorry.",
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

// ── tail rule targets broadcast boilerplate and still needs a long gap ─
{
  const farTail = [
    { text: "밥 먹었어?", start: 0, end: 1.2 },
    { text: "늘 시청해주셔서 감사합니다", start: 4.2, end: 5.0 },
  ];
  const result = sanitizeSttSegments(farTail, phrases, options);
  assert.equal(result.text, "밥 먹었어?");
  assert.deepEqual(result.dropped, [{ rule: 3, text: "늘 시청해주셔서 감사합니다" }]);

  const nearTail = [
    { text: "밥 먹었어?", start: 0, end: 1.2 },
    { text: "늘 시청해주셔서 감사합니다", start: 1.5, end: 2.3 },
  ];
  const kept = sanitizeSttSegments(nearTail, phrases, options);
  assert.equal(kept.text, "밥 먹었어? 늘 시청해주셔서 감사합니다");
  assert.equal(kept.dropped.length, 0);

  // A long tail segment is not a hallucination candidate even after a gap.
  const longTail = [
    { text: "밥 먹었어?", start: 0, end: 1.2 },
    { text: "오늘 이 영상을 끝까지 시청해주셔서 감사합니다 여러분", start: 4.2, end: 6.0 },
  ];
  assert.equal(sanitizeSttSegments(longTail, phrases, options).dropped.length, 0);

  // Whisper reports null for an unterminated previous chunk: no gap → rule 3 stays off.
  const nullEnd = [
    { text: "밥 먹었어?", start: 0, end: null },
    { text: "늘 시청해주셔서 감사합니다", start: 4.2, end: 5.0 },
  ];
  assert.equal(sanitizeSttSegments(nullEnd, phrases, options).dropped.length, 0);
}

// ── §7 case 6: without timestamps rule 3 never fires ──────────────────
{
  const result = sanitizeSttSegments(texts(["밥 먹었어?", "늘 시청해주셔서 감사합니다"]), phrases, options);
  assert.equal(result.text, "밥 먹었어? 늘 시청해주셔서 감사합니다");
  assert.equal(result.dropped.length, 0);
}

// ── §7 case 7: STT_SANITIZE=off is honoured by the config reader ──────
{
  const config = readSttConfig({ STT_SANITIZE: "off" });
  assert.equal(config.sanitize, false);
  assert.equal(readSttConfig({ STT_SANITIZE: "0" }).sanitize, false);
  assert.equal(readSttConfig({}).sanitize, true);
  assert.equal(readSttConfig({ STT_SANITIZE: "garbage" }).sanitize, true, "unknown values fall back to default");
  assert.equal(readSttConfig({}).language, "", "default is auto-detect (mixed ko/en/ja speech)");
  assert.equal(readSttConfig({ STT_LANGUAGE: "" }).language, "", "empty language = auto-detect");
  assert.equal(readSttConfig({ STT_LANGUAGE: "auto" }).language, "", '"auto" is an alias for auto-detect');
  assert.equal(readSttConfig({ STT_LANGUAGE: "ko" }).language, "ko");
  assert.equal(readSttConfig({ STT_LANGUAGE: " EN " }).language, "en");
  assert.equal(readSttConfig({ STT_LANGUAGE: "ja" }).language, "ja");
  assert.equal(
    readSttConfig({ STT_LANGUAGE: "ko-KR" }).language,
    "",
    "unsupported locale tags fall back to auto-detect",
  );
  assert.equal(
    readSttConfig({ STT_LANGUAGE: "not-a-language" }).language,
    "",
    "unknown languages fall back to auto-detect",
  );
  assert.equal(readSttConfig({ STT_REPEAT_THRESHOLD: "1" }).repeatThreshold, 3, "threshold below 2 is rejected");
  assert.equal(readSttConfig({ STT_REPEAT_THRESHOLD: "5" }).repeatThreshold, 5);
  assert.equal(readSttConfig({ STT_TRIM_THRESHOLD_DB: "abc" }).trimThresholdDb, -45);
  assert.equal(readSttConfig({ STT_TAIL_GAP_S: "2.5" }).tailGapSeconds, 2.5);
  assert.equal(readSttConfig({ STT_PHRASES_PATH: "  " }).phrasesPath, null);
  assert.equal(readSttConfig({ STT_PHRASES_PATH: "/tmp/x.json" }).phrasesPath, "/tmp/x.json");
}

// ── Japanese hallucinations (auto-detect can land in ja) ───────────────
{
  assert.equal(sanitizeSttSegments(texts(["ご視聴ありがとうございました。"]), phrases, options).text, "");
  assert.equal(
    sanitizeSttSegments(texts(["今日は手伝ってくれてありがとうございました"]), phrases, options).dropped.length,
    0,
  );
  const tail = [
    { text: "ご飯食べた？", start: 0, end: 1.0 },
    { text: "ありがとう、本当に", start: 3.5, end: 4.4 },
  ];
  assert.equal(sanitizeSttSegments(tail, phrases, options).text, "ご飯食べた？ ありがとう、本当に");
  assert.deepEqual(sanitizeSttSegments(tail, phrases, options).dropped, []);
}

// ── regex entries are whole-segment matches ───────────────────────────
{
  assert.equal(sanitizeSttSegments(texts(["MBC 뉴스 김민수입니다."]), phrases, options).text, "");
  assert.equal(
    sanitizeSttSegments(texts(["I'm sorry. I'm sorry. I'm sorry."]), phrases, options).text,
    "I'm sorry. I'm sorry. I'm sorry.",
  );
  assert.equal(sanitizeSttSegments(texts(["Thank you thank you"]), phrases, options).text, "Thank you thank you");
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
  assert.equal(sanitizeSttSegments(texts(["Thank you"]), compiled, options).text, "", "custom exact rules still apply");
  assert.equal(sanitizeSttSegments(texts(["ok"]), compiled, options).text, "", "custom regex rules still apply");
  assert.deepEqual(
    sanitizeSttSegments(
      [
        { text: "see you", start: 0, end: 1 },
        { text: "Bye.", start: 4, end: 5 },
      ],
      compiled,
      options,
    ).dropped,
    [{ rule: 3, text: "Bye." }],
    "custom tail rules still apply",
  );
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
      seedFrom: fileURLToPath(bundledPath),
      warn: (message) => warnings.push(message),
    });
    assert.ok(loader.get().exact.has("thanksforwatching"), "seeded from the bundled default");
    assert.equal(sanitizeSttSegments(texts(["I'm sorry"]), loader.get(), options).text, "I'm sorry");
    assert.deepEqual(warnings, []);

    await writeFile(path, JSON.stringify({ exact: ["custom phrase"], regex: [], tailSuspects: [] }), "utf-8");
    const future = new Date(Date.now() + 5_000);
    await utimes(path, future, future);
    assert.ok(loader.get().exact.has("customphrase"), "reloaded after the file changed");
    assert.ok(!loader.get().exact.has("thanksforwatching"));
    assert.equal(sanitizeSttSegments(texts(["custom phrase"]), loader.get(), options).text, "");
    assert.equal(
      sanitizeSttSegments(texts(["thanks for watching"]), loader.get(), options).text,
      "thanks for watching",
    );

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
