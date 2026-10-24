# 명함 인식 엔진 (F-010 ~ F-018)

이 문서는 "명함 사진 → 글자줄" 을 맡는 **엔진** 이야기다.
"글자줄 → 이름·회사·전화" 를 맡는 **파서** 규칙은 `packages/domain/src/ocrParser.ts` 의
주석과 `packages/domain/test/ocrParser.test.ts` 에 있다.

## 왜 엔진을 바꿨나

2026-10 KBT 측정(실제로 찍은 명함 52장 + 합성 묶음)에서 두 수치가 거의 붙었다.

| | |
|---|---|
| 파서 holdout 정확도 | **84.4%** |
| OCR 천장(글자가 읽히기라도 한 비율) | **84.9%** |

분류 손실은 사실상 0 이었다. 남은 손실은 전부 **tesseract 가 글자를 잘못 읽은 것**이다.
파서 규칙을 더 깎아도 천장이 안 올라간다. 그래서 엔진을 바꾼다.

GitHub 쪽을 훑은 결과는 `docs/ADR` 가 아니라 여기 한 줄로 적어 둔다 —
**명함 전용으로 쓸 만한 공개 파서는 없다.** `BizCardX` 계열(EasyOCR + 정규식 +
Streamlit)이나 `BusinessCard-DataExtraction-OCR-NER`(PyTesseract + spaCy) 같은
학습용 저장소뿐이고, 한국어 명함 꼴·마스킹·provenance 요건을 만족하는 것은 없다.
쓸 것이 있는 쪽은 **인식 엔진**이다.

| 후보 | 한국어 | 브라우저 | 판단 |
|---|---|---|---|
| tesseract.js (LSTM) | 음절 흘림 많음 | ○ | 폴백으로 남긴다 |
| **PaddleOCR PP-OCRv5** | 전용 인식 모델, 공개 지표 **88.0%** | ONNX Runtime Web 으로 ○ | **채택** |
| EasyOCR (CRAFT+CRNN) | 중간 | Python 전용 | 서버가 필요해 제외 |
| docTR / Surya | 영문 중심 / 라이선스 | △ | 제외 |

PP-OCRv5 는 Apache-2.0(PaddleOCR)이고, 모델 가중치는 PaddlePaddle 배포본을
RapidOCR 프로젝트가 ONNX 로 변환해 공개한 것을 쓴다.

## 엔진 사다리

`apps/web/src/lib/ocr.ts` 가 고른다. 사진은 두 갈래 모두 기기를 떠나지 않는다.

1. **PP-OCRv5 (on-device ONNX)** — 모델 파일이 올라와 있으면 이쪽.
   `engine = "ppocrv5-on-device"` 로 capture API 에 올라간다(F-187 과금 0원 규칙 유지).
2. **tesseract.js** — 모델이 없거나, WebGPU·wasm 이 막혔거나, 글자를 하나도 못 찾았으면 이쪽.
   `engine = "tesseract.js"`.

엔진 교체가 실패해도 스캔이 멈추지 않는 것이 요점이다. 모델을 안 내려 둔 배포는
지금과 똑같이 동작한다.

## 파이프라인

```
사진
 └ loadCanvas (EXIF 보정, 긴 변 2000)            apps/web/src/lib/imagePipeline.ts
 └ autoCorrect  테두리 검출 → 원근 보정           packages/domain/src/imaging.ts   (F-010)
 └ 엔진
    ├ PP-OCRv5
    │   ├ detResize           짧은 변 736, 32 배수          packages/domain/src/ppocr.ts
    │   ├ normalizeDetInput   CHW, ImageNet 평균/표준편차
    │   ├ [det.onnx]          DBNet → 확률맵 [1,1,H,W]      apps/web/src/lib/ocrPaddle.ts
    │   ├ dbBoxes             이진화 → 연결성분 → 최소면적 직사각형 → unclip
    │   ├ sortBoxesReadingOrder
    │   ├ warpPerspective     글자줄 하나씩 48px 높이로 자름 (세로줄은 90° 회전)
    │   ├ [rec.onnx]          CRNN → 확률 [1,T,C]
    │   └ decodeCtc           blank(0)·중복 제거, 평균 확률 = confidence
    └ tesseract.js
        └ enhanceForOcr (2–98% 명암 늘리기) → recognize
 └ parseBusinessCard / parseBadge                packages/domain/src/ocrParser.ts (F-016~F-018)
```

순수 계산부는 전부 `packages/domain` 에 있고(I/O·DOM 없음) `test/ppocr.test.ts`
29항목이 잠근다. `apps/web/src/lib/ocrPaddle.ts` 는 onnxruntime 세션만 다룬다.

### PaddleOCR 과 맞춘 값

바꾸면 정확도가 바로 떨어지는 값들이다.

| | 값 | 어디 |
|---|---|---|
| det 입력 | `limit_type=min`, `limit_side_len=736`, 32 배수, 긴 변 ≤ 4000 | `detResize` |
| det 정규화 | mean `[.485 .456 .406]` / std `[.229 .224 .225]`, RGB, CHW | `normalizeDetInput` |
| DB 후처리 | `thresh 0.3`, `box_thresh 0.6`, `unclip_ratio 1.5`, 최소 변 3px | `dbBoxes` |
| rec 입력 | 높이 48, 가로세로비 유지, 짧은 줄은 320 까지 0 패딩 | `recCropWidth`/`recPadWidth` |
| rec 정규화 | `(v/255 - 0.5) / 0.5` | `normalizeRecInput` |
| 글자표 | `[blank, …사전, " "]` — blank 가 0번 | `buildCharset` |
| 결과 버림 | 인식 확신 < 0.5 | `REC_DROP_SCORE` |

## 모델 내려 두기

모델은 합쳐 33MB 라 저장소에 담지 않는다(`.gitignore`).

```bash
pnpm ocr:models    # public/models/ocr/ 에 받고 sha256 확인 + public/ort/ 에 wasm 복사
pnpm ocr:verify    # 모델 출력 모양·사전 길이가 코드 전제와 맞는지 확인 (모델 없으면 건너뜀)
```

받는 것:

| 파일 | 크기 | 쓰임 |
|---|---|---|
| `ch_PP-OCRv5_det_mobile.onnx` | 4.6MB | 글자 위치 검출(언어 공통) |
| `korean_PP-OCRv5_rec_mobile.onnx` | 12.9MB | 한국어·영어 인식 |
| `ch_PP-OCRv5_rec_mobile.onnx` | 15.9MB | 중국어·일본어·영어 인식 |
| `ppocrv5_korean_dict.txt` | 11,945줄 | 한국어 글자표 (→ 클래스 11,947) |
| `ppocrv5_dict.txt` | 18,383줄 | 중/일 글자표 (→ 클래스 18,385) |

**사전 파일의 sha256 도 고정해 두었다.** 사전이 한 줄이라도 달라지면 CTC 인덱스가
통째로 밀려 글자가 조용히 어긋난다 — 에러도 안 난다. `pnpm ocr:verify` 가
`모델 출력 클래스 수 == 사전 줄 수 + 2` 를 직접 확인한다.

### 배포 메모

- 기본 경로는 자기 도메인(`/models/ocr/`, `/ort/`)이다. 바깥 CDN 을 기본값으로 두지 않는다 —
  명함 사진은 기기에 남지만 모델을 남의 집에서 받으면 스캔 시점이 그쪽 로그에 남는다.
  옮기려면 `NEXT_PUBLIC_OCR_MODEL_BASE` / `NEXT_PUBLIC_ORT_BASE`.
- onnxruntime-web 번들(약 400KB)과 모델은 **스캔을 시작할 때** 받는 별도 chunk 다.
  게스트 랜딩 초기 번들에는 들어가지 않는다(`build-manifest` 확인함) — LCP 예산 유지.
- 멀티스레드 wasm 은 COOP/COEP 헤더가 있어야 한다. 없으면 `numThreads = 1` 로 떨어뜨린다.
  WebGPU 가 있으면 그쪽을 먼저 쓴다.

## 실제 사진으로 재기

```bash
pnpm ocr:bench <사진들이 든 폴더> [--json out.json] [--dump <폴더>] [--no-rectify]
```

브라우저와 같은 순서·같은 함수를 쓴다(캔버스 대신 sharp 로 픽셀을 옮길 뿐).
`--dump` 는 원근 보정 결과와 검출 모델에 실제로 들어간 그림을 PNG 로 뱉는다 —
"왜 못 읽었나" 는 대개 그 그림을 보면 바로 보인다. 사진은 저장소에 두지 않는다.

**2026-10-24, 휴대폰으로 찍은 명함 13장** (어두운 바닥, 회전, 흰 글씨, 저대비 포함):

| 칸 | 고치기 전 | 고친 뒤 |
|---|---|---|
| 이름 | 9/13 | **11/13** |
| 회사 | 9/13 | **11/13** |
| 직책 | 8/13 | **10/13** |
| 휴대폰 | 9/13 | **12/13** |
| 전화 | 7/13 | **9/13** |
| 팩스 | 3/13 | **5/13** |
| 이메일 | 10/13 | **11/13** |
| 주소 | 8/13 | **9/13** |

그 과정에서 고친 것은 커밋 `4e9b429`에 적었고, 요점만 옮기면:
원근 보정이 자신 있게 틀릴 때의 원본 재시도, 여러 줄로 쪼개 인쇄한 번호 잇기,
한글 직책이 더 긴 낱말 안에서 걸리던 것, 영어 부서 낱말("Team Leader"),
회사 줄을 글씨 크기로 고르기.

**2차 (이름 칸 집중)** — 채운 수는 그대로지만 맞은 수가 올랐다:

| | 이름 | 회사 |
|---|---|---|
| 맞음 | 9 → **10** / 13 | 9 → **10** / 13 |
| 틀림 | 2 → **1** | 2 → **1** |
| 빈칸(확인 필요) | 2 | 2 |

고친 것:

- **자간을 넓게 벌려 찍은 이름** — `이사 최` · `원` · `석` 이 같은 줄에 글자 높이의 네 배씩
  떨어져 찍혀 상자가 따로 잡혔다. 같은 줄에 겹치고 가까우면 한 글자씩 되붙인다
  (`mergeSpacedChars`). → `이사 최원석`
- **직책을 이름보다 먼저 찍은 줄** — `이사 최원석` 은 앞머리를 이름으로 보는 흐름에
  걸리지 않아 줄 전체가 직책 칸에 들어갔다. 직책 뒤의 토막에서 이름을 찾는다.
  이때 직책 낱말은 후보에서 뺀다 — 안 그러면 `Director/대표이사` 의 '대표이사' 가
  네 글자 한글이라 이름이 된다(실제로 한 번 그렇게 깨졌다)
- **태그라인이 이름이 되는 것** — 대문자로 시작하는 두 낱말은 전부 사람 이름처럼
  보여 `Medical Community` 가 이름 칸에 앉았다. 사람 이름에 안 쓰이는 업무 낱말
  목록으로 거른다(이름을 가려내는 사전이 아니라 '아닌 것' 만 거르는 짧은 목록)
- **조사로 끝나는 조각** — `건강컨설팅의 프로` 가 끊겨 남은 `건강컨설팅의` 가 회사가
  됐다. 상호가 '의·은·를' 로 끝나는 일은 없다('이' 로 끝나는 상호는 흔해 뺐다)
- **쉼표가 든 줄은 부서가 아니다** — `Incheon, Korea` 가 부서 칸에 들어앉았다

**남은 오류는 OCR 이 글자 자체를 못 읽은 것이다** — 이름 칸은 13장 중 1장이 틀리고
(사진에서 이름이 뭉개졌다) 2장이 빈칸이다. 빈칸과 낮은 확신은 검토 화면에서
"확인 필요" 로 뜨고(F-017/F-018), 이름이 비면 저장 자체가 막혀 사람이 한 번 보게 된다 —
지어내지 않는다는 규칙의 결과다.

## 지금까지 확인한 것 / 아직 아닌 것

확인했다:

- 전·후처리·CTC 순수 함수 — 단위테스트 29항목(`packages/domain/test/ppocr.test.ts`)
- 파서 전체 — 27,170항목 통과(기존 QA 2,409 카드/배지 포함)
- 실제 모델로 끝까지 — Node(wasm)에서 합성 명함(900×540, SVG 렌더)을 넣어 검출→인식→파서를
  통과시켰다(2026-10-22). 검출 출력 `[1,1,736,1216]`, 글자줄 5개.
  - 영문: `LINKOS Labs` / `Jane Doe` / `Sales Director` / `jane@linkos.io` /
    `010-1234-5678` — 확신 0.96~1.00 (ch 모델, 클래스 18,385 = 사전 일치)
  - 한국어: `(주)그린코스메틱` / `최민서 부장` / `영업지원팀` / `010-9494-1212` /
    `ha.joo@green.co.kr` — 전부 확신 1.00, 5줄 266ms (korean 모델, 클래스 11,947 = 사전 일치).
    파서가 받아 `company·fullName·jobTitle·department·mobile·email` 여섯 칸을 다 채웠다.
- 번들 — webpack 빌드 통과, onnxruntime chunk 는 지연 로드

아직 아니다:

- **실제로 찍은 한국어 명함에서의 정확도.** 위 확인은 깨끗하게 렌더한 합성 이미지다 —
  파이프라인이 맞게 이어졌다는 뜻이고, 사진의 조명·초점·인쇄선에서의 정확도는 아니다.
  88.0% 는 PaddleOCR 이 보고한 공개 지표이고, KBT 측정 묶음(사진 52장)으로 다시 재야
  우리 숫자를 말할 수 있다. 그 묶음은 이 저장소 밖에 있다.
- 브라우저(WebGPU/wasm)에서의 속도. Node wasm 기준 글자줄당 수십 ms 수준이었다.
- 세로쓰기 일본어 명함. 90° 회전은 넣었지만 측정하지 않았다.
- PP-OCR 의 글자줄 방향 분류 모델(180° 뒤집힘)은 안 넣었다 — 원근 보정 뒤라 필요가 적다.

## 같이 손봐야 하는 곳

KBT 쪽 `platform/assets/cardkit.js` 에 같은 파서 규칙이 들어가 있다.
파서를 고치면 둘을 함께 고친다 — 한쪽만 고치면 같은 명함을 다르게 읽는다.
