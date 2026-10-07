# ADR 0001 — 모듈형 모놀리스 + 웹/PWA 우선

- 상태: 채택 (2026-10-07)
- 근거 문서: 백서 8장 "모듈형 모놀리스 + 비동기 워커 + 트랜잭셔널 Outbox", 07_AI_AGENT_BUILD_PROMPT §5

## 결정
1. `services/api` 를 도메인 모듈 경계로 나눈 단일 TypeScript 패키지로 구현하고, Next.js 라우트 핸들러(`/api/v1/*`)는 얇은 어댑터로만 둔다.
   서비스 분리는 운영 지표가 정당화할 때만 한다.
2. 외부 연동을 유발하는 쓰기는 같은 트랜잭션에서 `outbox_events` 에 기록하고, `worker.ts` 가 at-least-once 로 릴레이한다.
   Google People API 변경은 계정별 advisory lock 으로 직렬화하고 `contact:{id}:v{version}` 키로 idempotent 하게 큐잉한다.
3. 첫 출시 클라이언트는 **웹/PWA**. 백서 2장의 기술 현실(웹 브라우저 간 NFC/BLE P2P 불가, iOS Safari Web Bluetooth 미지원, Play Instant 종료)에 따라
   웹에서는 BLE 채널을 계획에서 제외하고 OS 공유 → NFC 태그 → 단축코드 → QR 순서를 쓴다. 네이티브 앱(apps/mobile)과 App Clip 은 후속.
4. OCR 은 Python 워커 대신 **기기 내 tesseract.js** 로 시작한다. 이미지가 서버로 가지 않아(데이터 최소화) 저장·악성파일 검사 부담이 없고,
   서버는 결정적 파서(`packages/domain/ocrParser.ts`)로 구조화한다. 정확도가 부족하면 같은 `/capture/cards` 계약 뒤에 서버 OCR 어댑터를 추가한다.
5. 인증은 비밀번호 없이 이메일 OTP + Google OIDC. 세션은 해시 저장된 불투명 토큰(httpOnly 쿠키)이며 1시간마다 회전, 회전된 토큰 재사용 시 전체 세션 폐기.

## 결과
- 단일 배포 단위(web)와 worker 두 프로세스로 운영 가능.
- STT/LLM/임베딩, 네이티브 BLE, App Clip, 조직 RBAC 는 TRACEABILITY 에 미착수/부분으로 명시되어 있다.
