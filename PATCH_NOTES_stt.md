# Local Whisper STT 필터 — 현재 적용 기준

2026-09-25 통합본. STT 수정 커밋 `bbcbd32e98b2`와 최신 CMB 복구 커밋 `8d39d46ceeb6`을 합쳤다. 기존 CMB·RAM·RP Individual 관련 5커밋과 후속 prepared-marker 복구 수정을 모두 보존한다. 페이블 원본 `e8bc99167c27ddde6a4277824d8ae0c781a7db32`의 STT를 가져와 보완했다.

**2026-09-25 언어 후속 정정:** Transformers.js 3.8.1의 Whisper 언어 감지는 구현되지 않았다. 실제 `WhisperForConditionalGeneration._retrieve_init_tokens`는 언어를 생략하면 영어(`en`)를 선택한다. 기존의 “기본 자동감지” 설명은 잘못됐으며, 이번 수정은 기본값을 한국어(`ko`)로 지정한다.

## 현재 동작

- PCM 앞뒤 무음을 잘라 Whisper 입력을 줄인다. 완전 무음은 모델을 호출하지 않는다.
- 언어는 기본 한국어(`ko`). `ko` / `en` / `ja`를 명시할 수 있으며, `auto` / 빈 값 / 그 밖의 값은 한국어로 돌아간다. 자동감지 선택지는 제공하지 않는다. 언어를 명시해도 한 발화 안의 혼용 인식 정확도를 보장하지는 않는다.
- 기본 목록은 구체적인 방송·시청·자막 문구를 거른다. `네`, `감사합니다`, `I'm sorry`, `okay`, `おやすみなさい` 등 일상 발화는 단독이거나 앞 발화와 오래 떨어져도 보존한다.
- 같은 세그먼트가 3회 이상 연속되면 1회만 남긴다. 사과·감사가 환각인지 텍스트만으로 구별할 수 없으므로 모두 지우지 않는다. 의미 있는 반복도 접힐 수 있다.
- 문장부호만 남는 결과는 빈 결과로 취급한다.
- **이번 hook에서 무음 또는 최종 빈 받아쓰기를 감지하면 “감지 실패” 오류를 전달한다.** Calls 1.0.16의 HTTP 400 → 오류 알림 경로를 쓰며, 안내를 transcript로 반환하지 않는다. 채팅 저장과 AI 호출 전에 종료한다.
- hook 이후 Calls 자체 RMS 필터가 비우는 결과에는 기존 영어 안내가 남을 수 있다. 모든 통화 오류 문구를 바꾸는 패치가 아니다.

기존 코드 연결은 `app.ts` import와 비-Lite bootstrap 호출 각 1줄이다. 새 `stt-config`, `stt-audio-trim`, `stt-sanitize`, `stt-pipeline-hook` 및 JSON 기본 목록을 사용한다. Calls 내부 서비스 사본도 사용하는 공유 Transformers ASR prototype을 감싸며, 설치 패키지는 수정하지 않는다. Whisper + Float32Array 입력에만 적용한다.

실패 안내는 공식 Calls 1.0.16 [server](https://raw.githubusercontent.com/Pasta-Devs/Marinara-Agents/main/packages/conversation-calls/server.mjs) / [client](https://raw.githubusercontent.com/Pasta-Devs/Marinara-Agents/main/packages/conversation-calls/client.js)의 처리 코드로 확인했으며 브라우저 실실행과 구분한다.

## 기본 설정

```dotenv
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

설정 생략 시 위 기본값이다. 언어·게이트 설정은 기동 시 읽으므로 변경 후 재시작이 필요하다. 문구 목록은 다음 호출 때 변경 시각을 보고 재로드한다. `STT_SANITIZE_LOG=off`는 삭제 원문 로그를 끈다.

`STT_TRIM=off`와 `STT_SANITIZE=off`는 각각 무음 트림과 텍스트 필터를 끈다. 이 두 값을 꺼도 `language`·`task=transcribe`·타임스탬프 설정은 유지한다. 예전 `STT_LANGUAGE=auto` 설정은 재시작 후 한국어 기본값으로 처리한다.

기본 목록은 사용자 파일이 없을 때만 `<DATA_DIR>/stt-hallucination-phrases.json`에 복사한다. **기존 파일은 덮어쓰지 않는다.** 예전 목록을 이미 seed했다면 코드 업데이트만으로 정상 인사 삭제가 사라지지 않는다. 사용자 지정 항목을 보존하면서 `exact`·`regex`·`tailSuspects`를 새 기본 목록과 대조해야 한다. gap 조정만으로 exact 규칙은 꺼지지 않는다. 이번 작업에서 운영 데이터 파일은 열거나 수정하지 않았다.

## 검증

Node 24에서 `node scripts/run-regressions.mjs --filter stt-` **3/3 PASS**, `--filter utility-sidecar` 및 `--filter runtime-integrity` **각 1/1 PASS**.
- 한영일 일상 발화 23종의 단독/짧은 간격/긴 간격 보존, 방송 문구 삭제, 반복 보존, 사용자 목록 재로드 확인.
- Windows 목록 경로는 fileURLToPath 사용.
- 실제 Transformers 3.8.1 클래스 부착 및 무음 오류 경로 확인. import/assert 실패는 skip/PASS로 숨기지 않는다.
- 테스트 DATA_DIR은 임시 폴더로 격리한다.
- 타입·전체 형식·lint·빌드 최종 결과는 작업공간 현황판이 연결한 수정 결과 기록을 기준으로 한다.
- 위 회귀는 모델 가중치를 사용하지 않으므로 실제 음성 인식·브라우저 표시·VPS·Telegram 수신을 입증하지 않는다. 별도 실행 결과와 구분한다.

## 통합·배포

이 PC에서 개인 포크는 `fork`, `origin`은 Pasta-Devs 원본이다. 기존 `2d7a2f48` 기반 STT 2커밋을 그대로 머지하지 않는다. 분리 작업본에서 `bbcbd32e98b2`와 `8d39d46ceeb6` 양쪽 이력을 보존한 통합 커밋을 만든 뒤 검증된 커밋만 로컬 candidate에 fast-forward한다. 과거 STT 전용 빌드로 최신 CMB 운영 코드를 교체하지 않는다.

배포 전에 최종 Engine 커밋 SHA를 확정하고, Companion에 `contract246CmbPreparedRecovery`를 상속한 exact-build 계약·registry·혼합 identity 회귀를 추가한다. 기존 `8d39d46ceeb6` 및 과거 지원 계약도 유지한다. 서버·화면은 같은 최종 SHA로 빌드해야 한다. 로컬 dirty 빌드는 운영 배포용이 아니다. 최종 커밋 번호와 검증 결과는 Companion의 `marinara/stt-hallucination-filter/README.md` 및 작업공간 결과 기록을 따른다.

운영 변경 승인을 받은 뒤 CMB·백업·알림봇 교체 절차와 무발송 probe/doctor를 확인한다. 이번 수정 요청에 push·운영 배포 승인이 포함되었다고 해석하지 않는다.

## 실통화 확인

기동 로그 `[stt-hook] Local Whisper filter applied`는 부착 증거다. 정상 발화+긴 무음, 순수 무음/전체 제거 시 감지 실패 알림과 채팅·AI 미호출, `ko`·`en`·`ja`별 정상 발화와 혼용 인식, 작은 목소리·첫/끝 음절 보존, 사용자 목록 재로드는 실제 통화로 별도 확인한다.
