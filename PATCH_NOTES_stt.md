# PATCH_NOTES_stt — Local Whisper 환각 필터 (재적용 절차)

기준: `candidate/v2.4.6-validation` (`2d7a2f48`, 2.4.6). 설계·탐색 근거는 `HANDOFF_marinara_stt_filter.md` §9·§12.

## 1. 기존 파일 변경 (합계 2줄)

### `packages/server/src/app.ts`

| 줄 | 삽입 내용 | 위치 근거 |
|---|---|---|
| 42 | `import { installSttPipelineHook } from "./services/sidecar/stt-pipeline-hook.js";` | `sidecar-process.service.js` import 바로 다음 (알파벳 순) |
| 300 | `    void installSttPipelineHook();` | `// ── Sidecar bootstrap (background, skipped in lite mode) ──` 아래 `if (!isLite) {` 블록의 첫 줄 |

다른 기존 파일은 손대지 않았다. `sidecar-speech.service.ts`는 의도적으로 무변경이다(§3 참고).

## 2. 신규 파일

| 경로 | 역할 |
|---|---|
| `packages/server/src/services/sidecar/stt-config.ts` | `STT_*` 환경변수 파싱. 잘못된 값은 기본값으로 폴백 |
| `packages/server/src/services/sidecar/stt-audio-trim.ts` | 게이트 A. 순수 함수 `trimSilence(samples, sampleRate, options)` |
| `packages/server/src/services/sidecar/stt-sanitize.ts` | 게이트 C. `normalizeSttText`, `compileSttPhraseList`, `sanitizeSttSegments`, chunks 어댑터, 문장 분할 폴백, 목록 파일 로더(mtime 변경 시 재로드) |
| `packages/server/src/services/sidecar/stt-pipeline-hook.ts` | `@huggingface/transformers`의 `AutomaticSpeechRecognitionPipeline.prototype._call`을 한 번 감싸 A→B→C를 적용. `installSttPipelineHook()`은 실패해도 서버를 멈추지 않음 |
| `packages/server/src/assets/stt-hallucination-phrases.json` | 기본 환각 문구 목록. 빌드 시 `dist/assets/`로 복사됨(`scripts/build.mjs copyRuntimeAssets`) |
| `scripts/regressions/stt-sanitize.regression.ts` | §7 케이스 1~7 + 정규화·정규식·어댑터·로더 |
| `scripts/regressions/stt-audio-trim.regression.ts` | 사인 1초+무음 5초 ≈1.3초, 순수 무음, 앞 트림, 최소 길이 |
| `scripts/regressions/stt-pipeline-hook.regression.ts` | 가짜 파이프라인으로 A+B+C 통합, 비-Whisper 우회, 멱등성, 실제 transformers 3.8.1 클래스 부착 확인 |

## 3. 왜 `sidecar-speech.service.ts`(P2)에 삽입하지 않았는가

- 통화 오디오는 Calls 패키지(`conversation-calls-1.0.16` `server.mjs`)의 `POST …/:id/media` 라우트가 처리하며, 그 라우트는 패키지 번들에 **복제된** speech 서비스 사본을 호출한다. 엔진 파일의 `transcribeWav`는 엔진 안에서 호출자가 없다.
- 설치된 패키지 파일은 manifest sha256으로 검증된 뒤 읽기 전용 스냅샷으로 로드되므로(`package-manager.service.ts` `readVerifiedInstalledPackageFile`) 번들 편집은 무결성 실패로 거부된다.
- 두 사본은 `DATA_DIR/capability-packages/node_modules → packages/server/node_modules` 심링크를 통해 같은 `@huggingface/transformers` ESM 인스턴스를 공유한다. 그래서 파이프라인 클래스의 prototype 한 곳을 감싸면 두 사본 모두에 적용된다.
- P2에 추가로 삽입하면 엔진 사본 경로에서 게이트가 두 번 적용된다(무해하지만 불필요).

## 4. 런타임 동작

- 서버 기동 시 `if (!isLite)` 블록에서 백그라운드로 설치. 조건: Lite 아님, onnxruntime-node 네이티브 바인딩 존재, Calls 패키지 설치됨, `STT_TRIM`/`STT_SANITIZE`/`STT_LANGUAGE` 중 하나라도 활성. 하나라도 어긋나면 아무것도 로드하지 않는다.
- 설치 시 `@huggingface/transformers`(및 onnxruntime-node)가 첫 통화가 아니라 기동 시점에 로드된다. 기동 로그: `[stt-hook] Local Whisper filter applied (language=ko trim=on sanitize=on phrases=<경로>)`.
- 목록 파일: `STT_PHRASES_PATH` 또는 `<DATA_DIR>/stt-hallucination-phrases.json`. 없으면 번들 기본본을 복사해 시드. 파일을 편집하면 다음 호출에서 자동 재로드(서버 재시작 불필요). JSON이 깨지면 경고 후 마지막 정상 목록 유지.
- 드롭 로그: `[stt-sanitize] rule=N dropped="…"` (info). `[stt-trim] Skipped model call: no voiced audio in <ms>ms` (info). 트림 상세는 debug. `STT_SANITIZE_LOG=off`로 억제.
- Whisper가 아닌 ASR 모델, `Float32Array`가 아닌 입력(URL/Buffer)에는 개입하지 않는다.

## 5. 환경변수

`HANDOFF_marinara_stt_filter.md` §5 표와 동일. 추가된 것은 `STT_PHRASES_PATH` 하나. `.env.example`/`docs/CONFIGURATION.md`는 충돌 면적을 줄이기 위해 수정하지 않았다. 필요하면 아래 블록을 `.env`에 넣는다.

```
# Local Whisper hallucination filter (see PATCH_NOTES_stt.md)
STT_LANGUAGE=ko
STT_SANITIZE=on
STT_SANITIZE_LOG=on
STT_REPEAT_THRESHOLD=3
STT_TAIL_GAP_S=1.5
STT_TAIL_MAX_CHARS=12
STT_TRIM=on
STT_TRIM_HEAD=on
STT_TRIM_THRESHOLD_DB=-45
STT_TRIM_TAIL_PAD_MS=300
STT_TRIM_HEAD_PAD_MS=500
STT_MIN_AUDIO_MS=300
# STT_PHRASES_PATH=/data/stt-hallucination-phrases.json
```

## 6. 검증 명령

```
pnpm install --frozen-lockfile
pnpm --filter @marinara-engine/server lint        # tsc --noEmit
pnpm format:check
pnpm impeccable:check
node ./scripts/run-regressions.mjs --filter stt-  # 3 files
pnpm --filter @marinara-engine/server build       # dist/assets/stt-hallucination-phrases.json 확인
```

2026-09-25 결과: tsc 0 error, Prettier clean, impeccable pass, STT 회귀 3/3 pass(실제 transformers 3.8.1 클래스 부착 포함), 인접 회귀(`utility-sidecar`, `runtime-integrity`) pass. 실제 모델 가중치로 통화를 돌리는 검증은 이 환경에서 huggingface.co가 차단되어 수행하지 못했다 → §8 수동 체크리스트.

## 7. 업스트림 리베이스 시 재적용 절차

1. 신규 파일 8개를 그대로 가져온다(충돌 없음).
2. `app.ts`에서 `sidecar-process.service.js` import 줄을 찾아 그 다음 줄에 import 1줄, `if (!isLite) {` 블록 첫 줄에 호출 1줄을 넣는다. 블록이 사라졌으면 `buildApp()` 안에서 `MARINARA_LITE`가 아닌 경로 아무 곳에 `void installSttPipelineHook();`를 둔다.
3. `@huggingface/transformers`가 4.x로 올라갔으면 `node ./scripts/run-regressions.mjs --filter stt-pipeline`을 돌려 "attached to the real … AutomaticSpeechRecognitionPipeline" 로그가 나오는지 본다. 안 나오면 `pipelines.js`에서 클래스명/`_call` 시그니처와 `return_timestamps` chunks 형태를 다시 확인해 `stt-pipeline-hook.ts`의 `applySttPipelineHook`·`sttSegmentsFromAsrOutput`만 고친다.
4. Calls 패키지가 갱신되어도 재적용은 필요 없다(번들이 같은 transformers 인스턴스를 쓰는 한).

## 8. 수동 통합 체크리스트 (사용자)

1. 서버 기동 로그에 `[stt-hook] Local Whisper filter applied …`가 있는가. 없으면 Calls 설치 여부·Lite 여부·바인딩 여부를 로그에서 확인.
2. 정상 발화 + 5초 무음 → 채팅에 환각 문장 0건. 로그에 `[stt-trim] …` 또는 `[stt-sanitize] rule=N …`가 찍히는가.
3. 순수 무음 10초 → 채팅 미삽입, LLM 미호출. **단, Calls 클라이언트는 400 응답에 "Local Whisper did not return a transcript" 토스트를 띄운다(패키지 동작, 기존과 동일).**
4. 한국어 문장 중 영어 단어 혼용 → `ko` 고정에 따른 오인식 수준 확인. 심하면 `STT_LANGUAGE=` (빈 값)으로 자동감지.
5. 문장을 실제로 "감사합니다"로 끝내기 → 유지되는가. 주의: 앞 문장과 1.5초 이상 떨어져 "감사합니다"만 따로 세그먼트가 되면 규칙 3이 지운다. 자주 그러면 `STT_TAIL_GAP_S`를 올리거나 `tailSuspects`에서 제거.
6. `<DATA_DIR>/stt-hallucination-phrases.json`을 편집하고 재시작 없이 다음 통화에 반영되는가.
