# 인수인계서: Marinara Engine 로컬 Whisper 환각 필터 패치

> **2026-09-25 후속 수정:** 아래 0~12절은 페이블 초기 설계·조사 기록이다. 현재 적용 기준은 [PATCH_NOTES_stt.md](PATCH_NOTES_stt.md)를 따른다. 최신 기반은 eb01019fed14. 일반 감사·사과·인사·짧은 답변은 보존하고, 반복은 1회 남긴다. 사용자 요청에 따라 hook의 빈 결과는 “감지 실패” 알림용 오류로 전달하며 채팅/AI 입력으로 보내지 않는다. 원래 전체 삭제 목록·조용한 무시 요구·오래된 머지 기준은 현재 규칙이 아니다.

- 작성일: 2026-09-25 (원본 PDF) / §9·§12 기입: 2026-09-25 (Claude Code)
- 대상: Claude Code (Marinara-Engine 개인 포크 작업)
- 작업 성격: 최소 침습 패치. 기능 추가가 아니라 후처리 계층 삽입.
- 기준 브랜치: `candidate/v2.4.6-validation` (`2d7a2f48`, package.json 2.4.6). 포크 `main`은 2.0.8로 오래되어 Calls 코드가 없다.

## 0. 한 줄 요약

Conversation 통화의 로컬 Whisper(Base) 받아쓰기가 발화 종료 후 꼬리 무음에서 "I'm sorry" 류 환각 문장을 반복 생성하는 문제를, 모델 교체 없이 (A) 오디오 꼬리 트림 → (B) 디코딩 옵션 고정 → (C) 텍스트 환각 필터 3단 게이트로 막는다. 기존 코드에는 최소 줄만 삽입하고, 로직은 전부 신규 파일에 격리한다.

## 1. 배경 (확인된 사실)

- Marinara Engine은 Pasta-Devs/Marinara-Engine, TypeScript, AGPL-3.0.
- Calls 패키지의 "Mic recording + Local Whisper" 모드는 Marinara를 실행하는 머신의 Node 프로세스 안에서 Transformers.js + ONNX Runtime으로 Whisper를 돌린다. 클라우드 STT 프로바이더 옵션은 없다.
- 제공 모델은 Whisper Tiny / Base 두 개뿐. 사용자는 현재 Base 사용 중이며, 그럼에도 환각 발생.
- 오디오 입력 모드 4종: Local Whisper(기본) / 브라우저 Web Speech / 수동 OS 받아쓰기 / 프로바이더 네이티브 오디오. 사용자의 메인 모델(GPT-5.6 Terra)은 오디오 입력 불가라 네이티브 모드 사용 불가.
- 클라이언트 측에 "records while unmuted, ignores silence"라는 VAD가 있다고 문서화되어 있으나, 실제로는 꼬리 무음이 파이프라인까지 도달하고 있음. (→ §9 P5에서 원인 확인: 무음 3초 후 녹음 종료라 꼬리 무음 최대 3초가 그대로 전송된다.)
- 업스트림에서 Transformers.js 3.8.1 → 4.3.0 및 ONNX Runtime 동시 마이그레이션이 진행 중(Issue #6603, PR #6606). STT 호출부 주변 코드가 곧 움직일 수 있으므로 패치 면적 최소화가 최우선 제약.
- 환각 메커니즘: Whisper가 무음/잡음 구간에서 학습 데이터에 흔했던 문장(영어: "I'm sorry", "Thank you", "Thanks for watching" / 한국어: "시청해 주셔서 감사합니다", "구독과 좋아요", "MBC 뉴스 ○○○입니다" 등)을 출력하는 현상. 모델 크기를 올려도 빈도만 줄고 사라지지 않는다.

## 2. 작업 전제 (미확인 → Claude Code가 소스에서 확인할 것)

아래는 설계 시점에 소스를 열어보지 않고 문서·PR 기록만으로 세운 가정이다. 파일 경로와 함수명은 가정하지 말고 반드시 grep으로 찾아서 이 문서의 §9 표를 채운 뒤 구현에 들어갈 것.

| # | 찾을 것 | 탐색 힌트 |
|---|---|---|
| P1 | Local Speech Model 레지스트리 (Tiny/Base의 HF repo ID, 다운로드 사이즈, RAM 표기가 정의된 곳) | `whisper-tiny`, `whisper-base`, `onnx-community`, `Xenova` |
| P2 | 서버에서 통화 오디오를 받아 ASR 파이프라인을 호출하고 텍스트를 반환하는 함수 | `automatic-speech-recognition`, `pipeline(`, `transcribe`, Calls 패키지 서버 라우트 |
| P3 | 그 텍스트를 통화 채팅에 사용자 발화로 삽입하는 호출부 | P2의 반환값을 소비하는 곳. 빈 문자열이 왔을 때 현재 어떻게 처리되는지 확인 필수 |
| P4 | P2에 들어오는 오디오의 형식 (webm/opus 바이너리인지, 이미 디코딩된 Float32 PCM인지, 샘플레이트) | P2 상단의 디코딩 코드, ffmpeg, AudioContext, decodeAudio |
| P5 | 클라이언트 VAD 구현 (무음 판정 임계값, 발화 종료 후 얼마나 더 녹음하는지) | Calls 패키지 클라이언트, unmute, silence, vad |
| P6 | 설치된 `@huggingface/transformers` 버전과, ASR 파이프라인 호출에 현재 넘기는 옵션 | package.json, P2 |
| P7 | 리포의 테스트 규약 (러너, 파일 위치, 네이밍) | 기존 `*.test.ts` / `*.regression.ts` |
| P8 | Lite 빌드에서 Local Whisper가 비활성화되는 분기 | Lite, LITE_MODE |

P1은 1차 작업에서 수정하지 않는다. 위치만 기록해 둔다(2차 모델 확장용).

## 3. 목표와 비목표

목표

1. 환각 문장이 통화 채팅과 LLM 컨텍스트에 들어가지 않게 한다.
2. 완전 로컬 처리를 유지한다. 외부 네트워크 호출 추가 금지.
3. 업스트림 리베이스 시 충돌이 최소가 되도록 기존 파일 변경을 3줄 이내로 억제한다.
4. 필터가 무엇을 버렸는지 사용자가 로그로 감사할 수 있게 한다.

비목표 (1차에서 하지 않음)

- 모델 추가/교체 (whisper-small, large-v3-turbo 등). 2차로 보류.
- UI 설정 패널 수정. 설정은 환경변수로만.
- 의존성 버전 변경. Transformers.js/ONNX 버전은 현재 그대로.
- 브라우저 Web Speech 모드, 네이티브 오디오 모드 등 Local Whisper 이외 경로 변경.

## 4. 아키텍처: 3단 게이트

```
[브라우저] 마이크 녹음 → 클라이언트 VAD → 서버 전송
                                          │
[서버]  P4 디코딩 ─→ ★ 게이트 A (PCM 꼬리 트림)
                      │
                   ASR 파이프라인 ←─ ★ 게이트 B (호출 옵션 고정)
                      │
                   세그먼트 배열 ─→ ★ 게이트 C (환각 필터)
                      │
                   정제 텍스트 ─→ P3 (빈 문자열이면 삽입 생략)
```

세 게이트 모두 신규 파일 안에 구현하고, P2에는 게이트 A·B·C를 각각 한 줄씩 끼워 넣는다. (→ §12: 실제 삽입 지점은 P2 함수가 아니라 공유 파이프라인 클래스다. 이유는 §9 P2·P3 참조.)

### 4-A. 게이트 A: 오디오 꼬리 트림 (`stt-audio-trim.ts`)

- 입력: Float32Array PCM + sampleRate (P4 결과에 따라 디코딩 단계가 필요하면 기존 디코딩 로직을 재사용하고, 새 디코더를 추가하지 않는다).
- 20~30ms 윈도우로 RMS를 계산, dBFS로 환산.
- 끝에서부터 스캔하여 임계값(기본 −45 dBFS) 이상인 마지막 윈도우를 찾고, 그 뒤로 `STT_TRIM_TAIL_PAD_MS`(기본 300ms)만 남기고 절단.
- 앞부분은 보수적으로: 임계값 이상 첫 윈도우 앞 `STT_TRIM_HEAD_PAD_MS`(기본 500ms)만 남기고 절단. 첫 음절 손실 위험이 있으므로 앞 트림은 `STT_TRIM_HEAD=off`로 끌 수 있게 한다.
- 트림 후 길이가 `STT_MIN_AUDIO_MS`(기본 300ms) 미만이면 파이프라인을 호출하지 않고 빈 결과를 반환한다.
- 순수 함수. 부작용 없음.

### 4-B. 게이트 B: 디코딩 옵션

P2의 파이프라인 호출에 다음을 병합한다. 옵션명은 P6에서 확인한 Transformers.js 버전의 실제 시그니처를 따를 것(3.x와 4.x가 다를 수 있음).

- `language`: `STT_LANGUAGE` 환경변수 (원문 기본 `ko` → §8 변경으로 기본 자동감지). `auto`/빈 문자열이면 옵션을 넘기지 않아 자동감지, `ko`/`en`/`ja` 등 코드면 고정.
- `task`: `transcribe` 고정.
- `return_timestamps`: `true`. 게이트 C가 세그먼트 단위로 동작하려면 필수. 세그먼트(chunks) 출력 형태를 P6에서 확인.
- 기존에 넘기던 옵션은 그대로 유지하고 위 항목만 덮어쓴다.

주의: `language=ko` 고정은 환각을 없애는 게 아니라 영어 환각을 한국어 환각으로 바꾼다. 따라서 게이트 C의 목록은 한국어가 주력이어야 한다.

### 4-C. 게이트 C: 환각 필터 (`stt-sanitize.ts` + `stt-hallucination-phrases.json`)

- 입력: 세그먼트 배열 `{ text: string, start?: number, end?: number }[]`. 타임스탬프가 없으면(파이프라인이 안 주면) 문장 부호 기준으로 분할해 폴백하되, 규칙 3은 비활성화.
- 출력: `{ text: string, dropped: { rule: 1|2|3, text: string }[] }`
- 정규화 함수 `normalize(s)`: 유니코드 NFKC → 소문자 → 공백·구두점·이모지 제거. 한글은 자모 분해하지 않는다.

규칙 (순서대로 적용)

1. 알려진 환각 문구 — 전체 일치 드롭. `normalize(segment)`가 목록 항목(문자열은 전체 일치, 정규식은 전체 매치 `^…$`)과 일치하면 드롭. 부분 일치 금지. 문장 중간에 실제로 나온 "감사합니다"를 잘라먹지 않기 위함.
2. 반복 붕괴. normalize 결과가 동일한 세그먼트가 연속 `STT_REPEAT_THRESHOLD`(기본 3)회 이상이면 첫 1회만 남기고 나머지 드롭. 완전 삭제가 아닌 1회 유지인 이유: "아니 아니 아니" 같은 정당한 반복 발화 보존. 규칙 1의 문구는 이미 전부 제거되었으므로 이 규칙은 목록에 없는 신규 환각의 안전망이다.
3. 꼬리 가중. 마지막 세그먼트가 (a) 길이 ≤ `STT_TAIL_MAX_CHARS`(기본 12)이고 (b) 직전 세그먼트와의 시간 간격 ≥ `STT_TAIL_GAP_S`(기본 1.5초)이며 (c) normalize 결과가 목록의 부분 문자열 후보(별도 배열 `tailSuspects`)와 일치하면 드롭. 규칙 1이 놓친 변형("죄송합니다 정말" 등)을 위치 근거로 잡는다. 타임스탬프가 없으면 이 규칙은 건너뛴다.
4. 전체 소거. 결과 텍스트가 공백뿐이면 빈 문자열을 반환한다. P3가 빈 문자열을 받았을 때 통화 채팅에 아무것도 넣지 않고 LLM 호출도 하지 않도록 보장한다. P3가 이미 그렇게 동작하면 손대지 않고, 아니면 P3에 조건 한 줄을 추가한다(이것이 기존 파일 변경 3줄 중 하나가 될 수 있음).

로깅: 드롭된 세그먼트를 `[stt-sanitize] rule=N dropped="…"` 형식으로 서버 로그에 남긴다. 로그 레벨은 기존 리포 로거의 info 수준. `STT_SANITIZE_LOG=off`로 끌 수 있게.

초기 목록(`stt-hallucination-phrases.json`, 사용자가 편집하는 데이터 파일. 코드에 하드코딩 금지). 이 목록은 정규화(공백·구두점 제거, 소문자)된 형태로 기록한다. 운영 초기 2주간 로그를 보며 사용자가 보강한다.

```json
{
  "exact": [
    "감사합니다", "고맙습니다", "시청해주셔서감사합니다", "시청해주셔서감사합니다다음영상에서만나요",
    "구독과좋아요부탁드립니다", "구독좋아요알림설정", "자막제공", "자막", "끝", "네", "음",
    "다음영상에서만나요", "오늘도시청해주셔서감사합니다",
    "imsorry", "thankyou", "thanks", "thanksforwatching", "thankyouforwatching",
    "pleasesubscribe", "subscribe", "bye", "you", "sorry", "okay", "hmm",
    "subtitlesbytheamaraorgcommunity", "transcribedby", "icantsharethat"
  ],
  "regex": [
    "^mbc뉴스.{1,5}입니다$", "^kbs뉴스.{1,5}입니다$", "^sbs뉴스.{1,5}입니다$",
    "^뉴스.{1,5}입니다$", "^(im)?sorry(imsorry)*$", "^(thankyou)+$"
  ],
  "tailSuspects": [
    "감사합니다", "죄송합니다", "sorry", "thankyou", "bye"
  ]
}
```

## 5. 설정 (환경변수, .env / CONFIGURATION.md 규약 따름)

| 변수 | 기본값 | 의미 |
|---|---|---|
| `STT_LANGUAGE` | (빈 값 = 자동감지) | `auto`/빈 값이면 Whisper가 발화마다 언어를 판별. `ko`/`en`/`ja` 등 코드로 고정 가능. 원문 기본값 `ko`는 2026-09-25 사용자 결정(영·일·한 혼용)으로 자동감지로 변경 |
| `STT_SANITIZE` | `on` | 게이트 C 전체 on/off |
| `STT_SANITIZE_LOG` | `on` | 드롭 로그 |
| `STT_REPEAT_THRESHOLD` | `3` | 규칙 2 임계 |
| `STT_TAIL_GAP_S` | `1.5` | 규칙 3 간격 |
| `STT_TAIL_MAX_CHARS` | `12` | 규칙 3 길이 상한 |
| `STT_TRIM` | `on` | 게이트 A on/off |
| `STT_TRIM_HEAD` | `on` | 앞 트림 on/off |
| `STT_TRIM_THRESHOLD_DB` | `-45` | 무음 임계 (dBFS) |
| `STT_TRIM_TAIL_PAD_MS` | `300` | 꼬리 여유 |
| `STT_TRIM_HEAD_PAD_MS` | `500` | 앞 여유 |
| `STT_MIN_AUDIO_MS` | `300` | 이보다 짧으면 파이프라인 호출 생략 |
| `STT_PHRASES_PATH` | `<DATA_DIR>/stt-hallucination-phrases.json` | (구현 시 추가) 사용자 편집용 목록 파일 경로. 없으면 번들 기본 목록을 이 위치에 복사해 시드 |

환경변수 파싱은 신규 파일 `stt-config.ts`에 모은다. 기존 설정 로더에 항목을 추가하지 않는다(패치 면적 억제).

## 6. 패치 면적 규칙 (엄수)

- 기존 파일 변경은 P2에 3줄(게이트 A 호출, 옵션 병합, 게이트 C 호출), 필요 시 P3에 1줄(빈 문자열 가드). 합계 4줄 초과 금지.
- 기존 함수의 시그니처, 반환 타입을 바꾸지 않는다. 게이트 C는 P2가 원래 반환하던 것과 같은 타입(문자열이면 문자열)을 반환하도록 어댑터를 신규 파일 쪽에 둔다.
- 신규 파일은 P2와 같은 디렉터리에 `stt` 접두어로 두되, 리포에 `utils/` 같은 관례가 있으면 그 관례를 따른다.
- P8 Lite 분기 안쪽에는 아무것도 넣지 않는다. Local Whisper가 도는 경로에만 개입한다.
- 작업 완료 시 `PATCH_NOTES_stt.md`에 수정한 기존 파일과 정확한 줄, 삽입한 코드를 기록한다. 업스트림 리베이스 시 이 파일만 보고 재적용할 수 있어야 한다.

## 7. 테스트

P7 규약에 맞춰 `stt-sanitize` 단위 테스트를 작성한다. 최소 케이스:

1. `["안녕 잘 지냈어", "I'm sorry", "I'm sorry", "I'm sorry"]` → `"안녕 잘 지냈어"`, dropped 3건 rule 1.
2. `["시청해 주셔서 감사합니다."]` → `""` (전체 소거).
3. `["오늘 도와줘서 정말 감사합니다"]` → 원문 유지 (부분 일치 금지 검증).
4. `["아니", "아니", "아니", "아니", "그게 아니라"]` → `"아니 그게 아니라"` (규칙 2, 1회 보존).
5. `["밥 먹었어?", "죄송합니다"]` 타임스탬프 간격 3초 → `"밥 먹었어?"` (규칙 3). 같은 입력에 간격 0.3초 → 원문 유지.
6. 타임스탬프 없는 입력에서 규칙 3이 동작하지 않는지.
7. `STT_SANITIZE=off`일 때 입력 그대로 통과.

게이트 A 단위 테스트: 합성 사인파 1초 + 무음 5초 → 출력 길이 ≈ 1.3초. 순수 무음 → 빈 결과.

수동 통합 검증(사용자가 실제 통화로 수행, Claude Code는 체크리스트만 제공):

- 정상 발화 + 5초 무음 → 환각 0건
- 순수 무음 10초 → 채팅에 아무것도 삽입되지 않음, LLM 호출 없음
- 한국어 문장 중 영어 단어 혼용 → `ko` 고정으로 인한 오인식 수준 확인
- 문장을 "감사합니다"로 실제로 끝내기 → 잘리지 않음
- 로그에 rule 번호가 정상 기록되는지

## 8. 확정된 결정 사항 (재논의 불필요)

- 반복 임계 N = 3.
- 전체 소거 시 조용히 버린다. 채팅에 "(인식 실패)" 표시를 넣지 않는다.
- ~~언어는 `ko` 고정을 기본으로 하되 env로 해제 가능.~~ → **변경(2026-09-25, 사용자):** 기본은 자동감지. 영어·일본어·한국어를 섞어 쓰므로 `STT_LANGUAGE=auto`(기본)/`ko`/`en`/`ja` 중 선택. 자동감지는 발화(30초 창) 단위로 한 언어를 고르므로 한 문장 안의 혼용은 지배 언어로 인식된다. 목록에 일본어 환각 문구를 추가했다.
- 규칙 1은 전체 일치만. 부분 일치는 규칙 3의 꼬리 조건에서만.
- 1차에서 모델 레지스트리는 건드리지 않는다.

## 9. 소스 확인 결과 기입란 (Claude Code가 채움, 2026-09-25)

기준: `candidate/v2.4.6-validation` @ `2d7a2f48`. Calls 패키지는 공식 카탈로그 `catalog/v2/catalog.json` 기준 `conversation-calls 1.0.16` (engine ≥ 2.4.1, sha256 `9489b6ed…`) 아티팩트를 내려받아 확인했다.

| # | 경로 | 함수/심볼 | 비고 |
|---|---|---|---|
| P1 | `packages/shared/src/types/sidecar.ts:385-407` | `SIDECAR_SPEECH_DEFAULT_MODEL_ID = "whisper_tiny"`, `SIDECAR_SPEECH_MODELS[]` | `Xenova/whisper-tiny` (180 MB / RAM 350 MB), `Xenova/whisper-base` (320 MB / RAM 650 MB). onnx-community 항목 없음. 1차 수정 없음 |
| P2 | `packages/server/src/services/sidecar/sidecar-speech.service.ts:480-519` | `SidecarSpeechService.transcribeWav(buffer: Buffer): Promise<string>` | 489 `decodePcmWav` → 490 `resampleLinear(…,16000)` → 491 `audioStats` → 492 `loadPipeline` → 493-500 옵션 → 501 `transcriber(samples, asrOptions)` → 502-507 text 조립 → 508-517 **기존 환각 필터**(`SILENCE_HALLUCINATION_PHRASES` 영어 5개 + RMS≤0.008 또는 peak≤0.035 조건, 22-30·231-245행). **삽입 줄 번호: 없음.** 이 엔진 파일의 `transcribeWav`는 엔진 안에서 호출자가 없다(엔진 라우트 `sidecar.routes.ts`는 status/download/delete만 사용). 실제 통화 경로는 Calls 패키지 `server.mjs`가 **같은 서비스 소스를 번들에 복제**한 사본(`class iP`, 인스턴스 `P9`, `transcribeWav` 오프셋 ≈2,029,900)을 호출한다. 설치 파일은 manifest sha256으로 검증되므로(`package-manager.service.ts:598-600`, `verifiedRuntimeFiles` → 0o400 스냅샷) 번들 편집 불가. → 삽입 지점을 두 사본이 공유하는 `@huggingface/transformers` 모듈 인스턴스의 `AutomaticSpeechRecognitionPipeline.prototype._call` (`pipelines.js:1743`)로 옮긴다. 파이프라인 객체는 `Callable` 클로저가 `closure._call(...args)`로 위임(`utils/generic.js:19-22`)하므로 prototype 패치가 기존 인스턴스에도 적용된다. 패키지의 `node_modules`는 `DATA_DIR/capability-packages/node_modules → packages/server/node_modules` 심링크(`capability-module-runtime.service.ts:145-158, 174-177`)라 Node가 realpath로 해석해 엔진과 동일 모듈 인스턴스를 공유한다. |
| P3 | Calls 패키지 `server.mjs` `POST …/:id/media` 핸들러 (오프셋 ≈2,305,700) | `k=(await P9.transcribeWav(p)).trim()` | **빈 문자열 처리 현황:** `if(!k) return 400 {error:"Local Whisper did not return a transcript"}`, `if(git(k)) return 400 "Local Whisper did not detect speech."` ("[BLANK_AUDIO]" 판정) → 그 뒤에야 `createMessage(kind:"speech")`와 LLM 턴. 즉 서버 측은 이미 "빈 문자열 = 채팅 미삽입·LLM 미호출"이다. P3 삽입 불필요(그리고 sha256 검증으로 불가). 단, 클라이언트(`client.js` `b0 → po(…,"Call speech transcription failed.")`, quiet 아님)는 400을 받으면 `Se.error(message)` 토스트를 띄운다. 따라서 "조용히 버림"은 서버 측만 성립하고, **드롭마다 "Local Whisper did not return a transcript" 토스트가 뜬다.** 이는 현재 업스트림 RMS 필터가 발동할 때도 동일한 기존 동작이다. 패키지 포크 없이는 제거 불가. |
| P4 | 클라이언트 `client.js` `cL()`; 서버 `sidecar-speech.service.ts:138-213` | `decodeAudioData → x5(모노 믹스) → v5(선형 리샘플 16000) → S5(16-bit PCM WAV)` / 서버 `decodePcmWav`, `resampleLinear` | **오디오 형식:** 클라이언트가 이미 WAV(RIFF, PCM16, mono)로 인코딩해 `call-audio.wav`(audio/wav)로 업로드. **샘플레이트:** 16000 Hz (클라이언트 리샘플, 서버 `TARGET_SAMPLE_RATE=16_000` 재확인). 파이프라인 입력은 `Float32Array` @16 kHz. 새 디코더 불필요 |
| P5 | Calls 패키지 `client.js` `TL` 콜백 (오프셋 ≈819,900) | `AnalyserNode(fftSize 1024, smoothing 0.15)` + `b5()` RMS | **VAD 임계/후행 녹음:** 120 ms 간격(`Wd`) 바이트 시간영역 RMS. 시작 임계 `DF=0.022`가 `eL=2`프레임 연속(≈240 ms), 유지 임계 `NF=0.013`. **마지막 유성 프레임 후 `PF=3000 ms` 무음이면 녹음 종료** → 꼬리 무음 최대 약 3초가 그대로 서버로 간다(환각의 직접 원인). 세그먼트 상한 `OF=60 s`. 폐기 조건: 길이<`RF=420 ms`, 유성<`BF=180 ms`, peakRms<`UF=0.022`. `MediaRecorder` timeslice 500 ms. getUserMedia: echoCancellation/noiseSuppression/autoGainControl on, mono. 패키지 코드라 수정 불가 → 게이트 A로 서버에서 보정 |
| P6 | `packages/server/package.json:23,43`, `pnpm-lock.yaml:1125` | `@huggingface/transformers ^3.8.1` (lock 3.8.1), `onnxruntime-node ^1.24.3` | **현재 호출 옵션:** `{ task: "transcribe" }`, 30초 초과 시 `{ chunk_length_s: 30, stride_length_s: 5, task: "transcribe" }`. 파이프라인 생성 옵션 `{ dtype: "q8", local_files_only, progress_callback }`. 3.8.1 시그니처(`pipelines.js:1639-1647`): `language`(코드 `"ko"` 또는 영문명, `common_whisper.js:129`), `task`, `return_timestamps: boolean | "word"`, `chunk_length_s`, `stride_length_s`, `force_full_sequences`. **chunks 출력 형태:** `{ text: string, chunks: [{ timestamp: [start: number, end: number | null], text: string }] }` (`pipelines.js:1679-1686`, `tokenizers.js:3915-3917`). 단일 Float32Array 입력 → 단일 객체 반환 |
| P7 | `scripts/run-regressions.mjs`, `scripts/regressions/**` | `node scripts/run-regressions.mjs --filter <text>` (`pnpm regression`) | **테스트 러너:** 자체 러너가 `*.regression.ts`를 tsx로 실행, 파일당 30초 예산, `node:assert/strict`. vitest/jest 없음. **위치 규약:** `scripts/regressions/<주제>.regression.ts`, 서버 소스는 `../../packages/server/src/….js`로 import (예: `utility-sidecar.regression.ts`). 타입 게이트: `pnpm --filter @marinara-engine/server lint` = `tsc --noEmit`. 서버 ESLint 없음(client만). Prettier: printWidth 120, 큰따옴표, semi |
| P8 | `sidecar-speech.service.ts:32,278`; `app.ts:63,298`; `routes/index.ts:130`; `local-embedder.ts:22` | `MARINARA_LITE === "true" \| "1"` → `isLite`; `isAvailable() = !isLite && hasNativeOnnxRuntimeBinding()` | 훅 설치는 `app.ts:298 if (!isLite)` 블록 안에 1줄. 훅 내부에서 onnxruntime-node 바인딩 존재와 Calls 설치 여부를 재확인하고, 없으면 아무것도 하지 않는다 |

## 10. 산출물

1. `stt-config.ts`, `stt-audio-trim.ts`, `stt-sanitize.ts`, `stt-pipeline-hook.ts`(§12 추가), `assets/stt-hallucination-phrases.json`
2. 기존 파일 최소 삽입 (§12: `app.ts` 2줄)
3. 단위 테스트 (`scripts/regressions/stt-sanitize.regression.ts`, `stt-audio-trim.regression.ts`, `stt-pipeline-hook.regression.ts`)
4. `PATCH_NOTES_stt.md` (수정 위치·재적용 절차)
5. §9 표가 채워진 이 문서

## 11. 2차 작업 (착수 금지, 기록만)

P1 레지스트리에 `onnx-community/whisper-small`, `onnx-community/whisper-large-v3-turbo` 항목 추가. 다운로드 사이즈·RAM 실측 후 표기. CPU 환경에서 통화 지연을 실측하여 small까지만 열지 판단. 1차 필터를 2주 이상 운영하고 인식률 자체가 불만일 때만 착수한다.

## 12. 부록: 탐색 결과에 따른 설계 변경 (Claude Code, 2026-09-25)

문서 §4·§6은 "P2 함수에 3줄 삽입"을 전제했으나, §9 P2·P3에서 확인된 사실 때문에 그대로 적용하면 **실제 통화 경로에 아무 효과가 없다.** 아래로 변경한다. §8의 확정 사항은 모두 유지한다.

### 12.1 왜 P2 삽입이 무효인가

1. 통화 오디오는 Calls 패키지 `server.mjs`의 라우트가 처리하고, 그 라우트는 패키지 번들 안에 복제된 speech 서비스 사본을 호출한다. 엔진의 `sidecar-speech.service.ts` `transcribeWav`는 엔진 내부에서 호출되지 않는다.
2. 설치된 패키지 파일은 sha256 검증 후 읽기 전용 스냅샷으로 로드되므로 번들을 직접 고칠 수 없다.
3. 패키지 사본과 엔진 사본은 동일한 `@huggingface/transformers` ESM 인스턴스를 공유한다(심링크 + realpath 해석).

### 12.2 변경된 삽입 지점

- 신규 `stt-pipeline-hook.ts`가 `@huggingface/transformers`를 import한 뒤 `AutomaticSpeechRecognitionPipeline.prototype._call`을 한 번 감싼다. 래퍼는 `model.config.model_type === "whisper"`이고 입력이 `Float32Array`일 때만 개입한다.
  - 게이트 A: 입력 Float32Array를 트림. 트림 후 길이가 `STT_MIN_AUDIO_MS` 미만이면 모델을 호출하지 않고 `{ text: "", chunks: [] }`를 반환.
  - 게이트 B: kwargs에 `task`, `return_timestamps: true`, (`STT_LANGUAGE`가 비어 있지 않으면) `language`를 병합. 기존 kwargs는 유지.
  - 게이트 C: 원본 `_call` 결과의 `chunks`를 세그먼트로 삼아 정제하고, `{ ...output, text: 정제 텍스트, chunks: 남은 chunks }`를 반환. 호출자가 보던 형태(`{ text }`)를 그대로 유지하므로 패키지 사본·엔진 사본 모두 무변경으로 동작한다.
- 기존 파일 변경: `packages/server/src/app.ts`에 import 1줄 + `if (!isLite)` 블록 안 호출 1줄 = **2줄** (예산 4줄 이내). `sidecar-speech.service.ts`는 손대지 않는다(훅이 엔진 사본까지 덮으므로 P2 삽입은 이중 적용이 된다).
- 훅은 서버 기동 직후 백그라운드에서 설치된다. transformers 모듈(및 onnxruntime-node 바인딩)이 첫 통화가 아니라 기동 시점에 로드되는 비용이 생긴다. Calls 미설치·Lite·바인딩 없음이면 아무것도 로드하지 않는다.

### 12.3 §8과의 충돌

- "전체 소거 시 조용히 버린다": 서버 측(채팅 미삽입·LLM 미호출)은 성립. 그러나 Calls 클라이언트가 400 응답에 오류 토스트를 띄우는 것은 패키지 코드라 막을 수 없다. 현재도 업스트림 RMS 필터가 발동하면 같은 토스트가 뜬다.
- 나머지(N=3, 규칙 1 전체 일치, 레지스트리 불변)는 그대로. 언어 기본값은 §8의 변경대로 자동감지.

### 12.4 파일명 관례

리포 서버 소스는 kebab-case(`sidecar-speech.service.ts`)이므로 `stt-config.ts`, `stt-audio-trim.ts`, `stt-sanitize.ts`, `stt-pipeline-hook.ts`로 둔다. 목록 JSON은 빌드가 dist로 복사하는 `packages/server/src/assets/`에 기본본을 두고, 런타임에 `DATA_DIR/stt-hallucination-phrases.json`으로 시드하여 사용자가 편집한다(파일 mtime 변경 시 자동 재로드).

### 12.5 업스트림 4.x 마이그레이션 시 확인할 것

- `AutomaticSpeechRecognitionPipeline`이 여전히 export되고 `_call(audio, kwargs)` 시그니처가 유지되는지.
- `return_timestamps: true`의 chunks 형태(`timestamp: [start, end]`)가 유지되는지.
- 훅은 클래스나 메서드를 찾지 못하면 warn 로그 후 아무것도 하지 않는다(기동 실패 없음).
