# LINKOS QA Matrix — generated cases & 100-environment simulation

This layer adds **~27,000 deterministic generated cases** on top of the existing unit, integration, e2e and scenario
suites, plus a **100-environment browser simulation**. It is meant to run in CI and to find real bugs. It found
**14 bugs**, and all 14 are fixed. Each fix has a regression case (§4).

| Command | What runs | Wall time (this machine) |
|---|---|---|
| `pnpm qa` | `packages/domain/test/qa/*.test.ts` (26,595 cases) + `services/api/test/qa-api.integration.test.ts` (464 cases, real Postgres) | ~17 s + ~4 s |
| `pnpm matrix` | `playwright.matrix.config.ts` → `tests/matrix/journey.spec.ts` × 100 environments (200 tests, 4 workers) | **9.7 min** |
| CI | `.github/workflows/qa.yml`: `pnpm qa` on every push/PR. Matrix runs nightly (03:17 KST) and on `workflow_dispatch`, split into 4 shards. The domain QA files also run inside the existing `verify` job (`pnpm test`), which adds about 10 s. | |

## 1. How cases are generated

- **Deterministic seeds.** `packages/domain/test/qa/_gen.ts` is a mulberry32 PRNG. Every case gets its own seed,
  derived as `salt × 1,000,003 + index`. A failing case is reproducible from its index. `QA_SEED=<int>` explores a
  fresh input space on your machine; CI always uses the default seed. Nothing calls `Math.random`, so a red build is
  never flaky.
- **Independent oracles.** Expected values come from separate reference logic in the tests, never from the module
  under test. Examples:
  - the country/trunk-prefix table for E.164
  - the Accept-Language oracle
  - RFC 4180 CSV, vCard and RFC 5545 ICS unfold/unescape parsers
  - an RFC 2047 decoder
  - `node:crypto` for SHA-256/HMAC/base64url
- **Invariants over examples.** Each module has properties checked over every generated input. Examples:
  - every OCR value is a literal substring of its source line
  - QR is never first while another channel exists
  - an idempotency key never maps to two bodies
  - a merge never invents data
  - a wider audience never sees fewer fields
- **Simulation.** The offline outbox runs 300 seeded sessions against a simulated idempotent server. The simulated
  client is the same logic as `apps/web/src/lib/offline.ts`. Sessions include a flaky network (lost responses, 5xx,
  429, network down) and user edits made while a request is in flight. Final server state must equal the user's
  intent, applied exactly once.

## 2. Case counts by area

| Area (file) | Cases | What is generated / checked |
|---|---:|---|
| OCR parser + badge (`ocr.qa`) | 2,409 | 2,000 synthetic cards (500 each ko/en/ja/zh): 6 layouts, 15 phone formats, 14 labels, noisy confidences (NaN, −0.3, 250, ∞), OCR O↔0 / l↔1 swaps, junk lines, odd whitespace. Plus 400 badges and degenerate inputs at the API size cap. Checks: grounded (rule 6), confidence ∈ [0,1], provenance=ocr, clean e-mail/phone recall. |
| Normalization (`normalize.qa`) | 1,766 | 41 countries × 9 phone formats × 3 numbers: intl, `00`, `(0)`, `+82 010…`, national, full-width, NBSP, tabs, E.164. Checks: E.164 output and idempotence. Also 300 e-mails, 200 URLs, 200 names. |
| Redaction (`redact.qa`) | 1,401 | 1,200 log lines mixing e-mails and 15 phone formats (15% full-width) in ko/en/ja/zh prose, and 200 nested payloads. No e-mail survives, no full phone digit run survives, output is idempotent. |
| ACL + state machines + handoff (`state.qa`) | 5,233 | All 25 ACL pairs and 300 field lists. All 196 exchange transitions and 12 × 5,000-step random walks. All 81 intro transitions and 10 × 2,000-step walks. 4,608 capability vectors (exhaustive) for the handoff ladder, with a failover walk. |
| Scoring & duplicates (`scoring.qa`) | 2,451 | 600 strength vectors (bounds, monotone per signal) and 200 cooling-risk inputs. 500 match pairs plus 50 ranked pools. 800 contact pairs: duplicate symmetry, merge never invents or loses data. |
| Formats (`formats.qa`) | 1,631 | 500 hostile vCards, 300 CSV sheets (formula guard), 400 ICS events (≤ 75-octet folding, round-trip), 300 RFC 2047 subjects plus header injection. Webhook SSRF: 31 private and 8 public hosts, retry policy. |
| i18n, tokens, consent, templates, field mapping (`misc.qa`) | 5,029 | 1,000 Accept-Language headers vs. the oracle. Catalog parity for every key × locale (guest, card, scanner). 1,000 tokens and 1,000 short codes. Consent truth tables. 500 templates. CRM mapping across 5 provider/object combos × 100 contacts. |
| RBAC, SSO, plans (`rbac.qa`) | 1,664 | 5 roles × 23 permissions. Role-assignment, invite and orphan matrices. 12 e-mail spellings × 5 login methods × roles for SSO enforcement and domain join. 200 policy merges. Plans × metrics × seats. Subscription status × grace × period. |
| Offline / crypto / pairing / acoustic (`offline.qa`) | 2,786 | 300 outbox simulations, 300 readyItems fuzz cases, decide per HTTP status. 300 offline pass/receipt sign-verify-tamper cases. 500 SHA-256/HMAC vectors vs `node:crypto`. 500 BLE UUID round-trips, 200 proximity cases, 600 acoustic frames (single-symbol and transposition detection), 24 noisy PCM decodes at 44.1/48 kHz. |
| Imaging, time zones, flags (`geo.qa`) | 2,214 | 400 homography/hull/quad cases, 24 synthetic card photos for outline detection. 14 time zones × 40 wall-clock times (DST gaps, +5:45, +12:45). 200 free-slot plans, 100 follow-up schedules. 300 flag rollouts (monotone), 100 experiments, 200 analytics prop sets. |
| Named regressions (`regressions.qa`) | 11 | One named case per domain bug (§4) |
| **Domain total** | **26,595** | runtime ≈ 33 s of test time, ≈ 17 s wall (parallel) |
| API (`qa-api.integration`) | 464 | **312 authz/id-hygiene cases.** 78 ops (contacts, notes, encounters, merge, meetings, recordings, follow-ups, exchange sessions, intros, rooms, room files, events, exports, card images, messages, templates, sequences, profiles, CTAs, access/action requests, org admin, team book, graph) × 4 variants: other user, anonymous, malformed id, unknown uuid. **Further cases.** 15 member-RBAC denials. 22 private-note leak paths (team views, exports, search, AI drafts, intro drafts, rooms, public card, guest landing, notifications, outbox/audit payloads). 17 schemas (17 valid + 75 invalid bodies). 13 service-level validations. 8 idempotency replays. |
| **Total executed generated cases** | **27,059** | plus 200 browser journeys (100 environments × 2) |

## 3. 100-environment browser simulation

**Environment selection.** `tests/matrix/environments.ts` builds the 100 environments deterministically:
- **88 phone/tablet environments.** These are every distinct viewport × DPR among the 136 non-desktop Playwright
  descriptors, in catalog order. Duplicates such as iPhone 13 = iPhone 13 Pro are skipped.
- **12 desktop configurations.** These are derived from the 7 desktop descriptors at real-world resolutions, from
  1024×768 up to 2560×1440 HiDPI.

All environments run in **Chromium**. Webkit and Firefox descriptors keep their viewport, DPR, touch support and user
agent.

**Rotating settings.** Each environment gets one value from each of these:

| Setting | Values | Distribution |
|---|---|---|
| Locale | ko-KR, en-US, ja-JP, zh-CN, de-DE, fr-FR, es-ES, en-GB | 12–13 each |
| Time zone | 11 zones | 9–10 each |
| Color scheme | light, dark | 50 / 50 |
| Reduced motion | reduce, no-preference | 34 / 66 |
| Network | fast, CDP throttling, offline-then-online | 70 / 20 / 10 |

The throttled network is slow 3G, using WebPageTest's profile: 400 ms RTT, 400 kbps down/up. The offline-then-online
environments cut the network right before sending the reply, then restore it.

**The journey.** Every environment runs this journey (`tests/matrix/journey.spec.ts`):

1. Landing `/`: h1 and "무료로 시작하기" CTA visible.
2. `/login`: e-mail field editable.
3. A sender is created through the HTTP API (OTP dev echo) with a profile and an exchange session.
4. `/x/{token}`. **FCP budget:** under 2.5 s, or under 6 s when throttled.
   - The sender's name is visible.
   - The private field and the QR fallback are not visible (rules 3 and 6).
5. Reply CTA. The manual-entry button is checked in the guest's negotiated language. Fill the form; send stays
   disabled until consent is given.
6. Offline environments only: going offline shows the localized network error, then the send succeeds once the
   network is back.
7. Localized "교환 완료 / Exchange complete / 交換 完了" heading, then the claim CTA (rule 2).
8. Signed-in `/app` home with the sender's cookies: the h1 contains their name.
9. `GET /api/v1/contacts/not-a-uuid` and an unknown uuid both return **404**.

**Checked at every step:**
- no `pageerror`
- no `console.error`
- no failed same-origin request
- no same-origin HTTP ≥ 400
- no horizontal overflow
- all eager images decoded
- `document.fonts` is `loaded` with no failed web font

**Results (full run):**
- **200/200 passed, 0 flaky, wall 9.7 min**, with 4 workers on a shared CI-class container, including the server start.
- **Guest landing FCP:**

| Network | n | Median | p75 | Max |
|---|---:|---:|---:|---:|
| fast | 70 | 528 ms | 716 ms | 1,528 ms |
| offline-then-online | 10 | 516 ms | — | — |
| slow 3G | 20 | 4,432 ms | 4,528 ms | 4,648 ms |

### Environment table

| # | Device descriptor | Kind | Viewport @DPR | Locale | Time zone | Scheme | Motion | Network |
|---|---|---|---|---|---|---|---|---|
| 001 | Blackberry PlayBook | tablet | 600×1024 @1x | ko-KR | Asia/Seoul | light | reduce | fast |
| 002 | Blackberry PlayBook landscape | tablet | 1024×600 @1x | en-US | Asia/Kolkata | light | — | fast |
| 003 | BlackBerry Z30 | phone | 360×640 @2x | ja-JP | Asia/Tokyo | dark | — | fast |
| 004 | BlackBerry Z30 landscape | phone | 640×360 @2x | zh-CN | Asia/Shanghai | dark | reduce | fast |
| 005 | Galaxy Note 3 | phone | 360×640 @3x | de-DE | Australia/Sydney | light | — | slow3g |
| 006 | Galaxy Note 3 landscape | phone | 640×360 @3x | fr-FR | Europe/Berlin | light | — | fast |
| 007 | Galaxy S8 | phone | 360×740 @3x | es-ES | Pacific/Auckland | dark | reduce | fast |
| 008 | Galaxy S8 landscape | phone | 740×360 @3x | en-GB | America/New_York | dark | — | offline-then-online |
| 009 | Galaxy S9+ | phone | 320×658 @4.5x | ko-KR | America/Los_Angeles | light | — | fast |
| 010 | Galaxy S9+ landscape | phone | 658×320 @4.5x | en-US | America/Sao_Paulo | light | reduce | slow3g |
| 011 | Galaxy S24 | phone | 360×780 @3x | ja-JP | UTC | dark | — | fast |
| 012 | Galaxy S24 landscape | phone | 780×360 @3x | zh-CN | Asia/Seoul | dark | — | fast |
| 013 | Galaxy A55 | phone | 480×1040 @2.25x | de-DE | Asia/Kolkata | light | reduce | fast |
| 014 | Galaxy A55 landscape | phone | 1040×480 @2.25x | fr-FR | Asia/Tokyo | light | — | fast |
| 015 | Galaxy Tab S4 | tablet | 712×1138 @2.25x | es-ES | Asia/Shanghai | dark | — | slow3g |
| 016 | Galaxy Tab S4 landscape | tablet | 1138×712 @2.25x | en-GB | Australia/Sydney | dark | reduce | fast |
| 017 | Galaxy Tab S9 | tablet | 640×1024 @2.5x | ko-KR | Europe/Berlin | light | — | fast |
| 018 | Galaxy Tab S9 landscape | tablet | 1024×640 @2.5x | en-US | Pacific/Auckland | light | — | offline-then-online |
| 019 | iPad (gen 5) | tablet | 768×1024 @2x | ja-JP | America/New_York | dark | reduce | fast |
| 020 | iPad (gen 5) landscape | tablet | 1024×768 @2x | zh-CN | America/Los_Angeles | dark | — | slow3g |
| 021 | iPad (gen 7) | tablet | 810×1080 @2x | de-DE | America/Sao_Paulo | light | — | fast |
| 022 | iPad (gen 7) landscape | tablet | 1080×810 @2x | fr-FR | UTC | light | reduce | fast |
| 023 | iPad (gen 11) | tablet | 656×944 @2.5x | es-ES | Asia/Seoul | dark | — | fast |
| 024 | iPad (gen 11) landscape | tablet | 944×656 @2.5x | en-GB | Asia/Kolkata | dark | — | fast |
| 025 | iPad Pro 11 | tablet | 834×1194 @2x | ko-KR | Asia/Tokyo | light | reduce | slow3g |
| 026 | iPad Pro 11 landscape | tablet | 1194×834 @2x | en-US | Asia/Shanghai | light | — | fast |
| 027 | iPhone 6 | phone | 375×667 @2x | ja-JP | Australia/Sydney | dark | — | fast |
| 028 | iPhone 6 landscape | phone | 667×375 @2x | zh-CN | Europe/Berlin | dark | reduce | offline-then-online |
| 029 | iPhone 6 Plus | phone | 414×736 @3x | de-DE | Pacific/Auckland | light | — | fast |
| 030 | iPhone 6 Plus landscape | phone | 736×414 @3x | fr-FR | America/New_York | light | — | slow3g |
| 031 | iPhone SE | phone | 320×568 @2x | es-ES | America/Los_Angeles | dark | reduce | fast |
| 032 | iPhone SE landscape | phone | 568×320 @2x | en-GB | America/Sao_Paulo | dark | — | fast |
| 033 | iPhone X | phone | 375×812 @3x | ko-KR | UTC | light | — | fast |
| 034 | iPhone X landscape | phone | 812×375 @3x | en-US | Asia/Seoul | light | reduce | fast |
| 035 | iPhone XR | phone | 414×896 @3x | ja-JP | Asia/Kolkata | dark | — | slow3g |
| 036 | iPhone XR landscape | phone | 896×414 @3x | zh-CN | Asia/Tokyo | dark | — | fast |
| 037 | iPhone 11 | phone | 414×715 @2x | de-DE | Asia/Shanghai | light | reduce | fast |
| 038 | iPhone 11 landscape | phone | 800×364 @2x | fr-FR | Australia/Sydney | light | — | offline-then-online |
| 039 | iPhone 11 Pro | phone | 375×635 @3x | es-ES | Europe/Berlin | dark | — | fast |
| 040 | iPhone 11 Pro landscape | phone | 724×325 @3x | en-GB | Pacific/Auckland | dark | reduce | slow3g |
| 041 | iPhone 11 Pro Max | phone | 414×715 @3x | ko-KR | America/New_York | light | — | fast |
| 042 | iPhone 11 Pro Max landscape | phone | 808×364 @3x | en-US | America/Los_Angeles | light | — | fast |
| 043 | iPhone 12 | phone | 390×664 @3x | ja-JP | America/Sao_Paulo | dark | reduce | fast |
| 044 | iPhone 12 landscape | phone | 750×340 @3x | zh-CN | UTC | dark | — | fast |
| 045 | iPhone 12 Pro Max | phone | 428×746 @3x | de-DE | Asia/Seoul | light | — | slow3g |
| 046 | iPhone 12 Pro Max landscape | phone | 832×378 @3x | fr-FR | Asia/Kolkata | light | reduce | fast |
| 047 | iPhone 12 Mini | phone | 375×629 @3x | es-ES | Asia/Tokyo | dark | — | fast |
| 048 | iPhone 12 Mini landscape | phone | 712×325 @3x | en-GB | Asia/Shanghai | dark | — | offline-then-online |
| 049 | iPhone 13 landscape | phone | 750×342 @3x | ko-KR | Australia/Sydney | light | reduce | fast |
| 050 | iPhone 13 Pro Max landscape | phone | 832×380 @3x | en-US | Europe/Berlin | light | — | slow3g |
| 051 | iPhone 13 Mini landscape | phone | 712×327 @3x | ja-JP | Pacific/Auckland | dark | — | fast |
| 052 | iPhone 14 Pro | phone | 393×660 @3x | zh-CN | America/New_York | dark | reduce | fast |
| 053 | iPhone 14 Pro landscape | phone | 734×343 @3x | de-DE | America/Los_Angeles | light | — | fast |
| 054 | iPhone 14 Pro Max | phone | 430×740 @3x | fr-FR | America/Sao_Paulo | light | — | fast |
| 055 | iPhone 14 Pro Max landscape | phone | 814×380 @3x | es-ES | UTC | dark | reduce | slow3g |
| 056 | iPhone 15 | phone | 393×659 @3x | en-GB | Asia/Seoul | dark | — | fast |
| 057 | iPhone 15 Plus | phone | 430×739 @3x | ko-KR | Asia/Kolkata | light | — | fast |
| 058 | Kindle Fire HDX | tablet | 800×1280 @2x | en-US | Asia/Tokyo | light | reduce | offline-then-online |
| 059 | Kindle Fire HDX landscape | tablet | 1280×800 @2x | ja-JP | Asia/Shanghai | dark | — | fast |
| 060 | LG Optimus L70 | phone | 384×640 @1.25x | zh-CN | Australia/Sydney | dark | — | slow3g |
| 061 | LG Optimus L70 landscape | phone | 640×384 @1.25x | de-DE | Europe/Berlin | light | reduce | fast |
| 062 | Microsoft Lumia 950 | phone | 360×640 @4x | fr-FR | Pacific/Auckland | light | — | fast |
| 063 | Microsoft Lumia 950 landscape | phone | 640×360 @4x | es-ES | America/New_York | dark | — | fast |
| 064 | Nexus 4 | phone | 384×640 @2x | en-GB | America/Los_Angeles | dark | reduce | fast |
| 065 | Nexus 4 landscape | phone | 640×384 @2x | ko-KR | America/Sao_Paulo | light | — | slow3g |
| 066 | Nexus 5X | phone | 412×732 @2.625x | en-US | UTC | light | — | fast |
| 067 | Nexus 5X landscape | phone | 732×412 @2.625x | ja-JP | Asia/Seoul | dark | reduce | fast |
| 068 | Nexus 6 | phone | 412×732 @3.5x | zh-CN | Asia/Kolkata | dark | — | offline-then-online |
| 069 | Nexus 6 landscape | phone | 732×412 @3.5x | de-DE | Asia/Tokyo | light | — | fast |
| 070 | Nexus 7 | tablet | 600×960 @2x | fr-FR | Asia/Shanghai | light | reduce | slow3g |
| 071 | Nexus 7 landscape | tablet | 960×600 @2x | es-ES | Australia/Sydney | dark | — | fast |
| 072 | Nokia Lumia 520 | phone | 320×533 @1.5x | en-GB | Europe/Berlin | dark | — | fast |
| 073 | Nokia Lumia 520 landscape | phone | 533×320 @1.5x | ko-KR | Pacific/Auckland | light | reduce | fast |
| 074 | Nokia N9 | phone | 480×854 @1x | en-US | America/New_York | light | — | fast |
| 075 | Nokia N9 landscape | phone | 854×480 @1x | ja-JP | America/Los_Angeles | dark | — | slow3g |
| 076 | Pixel 2 | phone | 411×731 @2.625x | zh-CN | America/Sao_Paulo | dark | reduce | fast |
| 077 | Pixel 2 landscape | phone | 731×411 @2.625x | de-DE | UTC | light | — | fast |
| 078 | Pixel 2 XL | phone | 411×823 @3.5x | fr-FR | Asia/Seoul | light | — | offline-then-online |
| 079 | Pixel 2 XL landscape | phone | 823×411 @3.5x | es-ES | Asia/Kolkata | dark | reduce | fast |
| 080 | Pixel 3 | phone | 393×786 @2.75x | en-GB | Asia/Tokyo | dark | — | slow3g |
| 081 | Pixel 3 landscape | phone | 786×393 @2.75x | ko-KR | Asia/Shanghai | light | — | fast |
| 082 | Pixel 4 | phone | 353×745 @3x | en-US | Australia/Sydney | light | reduce | fast |
| 083 | Pixel 4 landscape | phone | 745×353 @3x | ja-JP | Europe/Berlin | dark | — | fast |
| 084 | Pixel 4a (5G) | phone | 412×765 @2.63x | zh-CN | Pacific/Auckland | dark | — | fast |
| 085 | Pixel 4a (5G) landscape | phone | 840×312 @2.63x | de-DE | America/New_York | light | reduce | slow3g |
| 086 | Pixel 5 | phone | 393×727 @2.75x | fr-FR | America/Los_Angeles | light | — | fast |
| 087 | Pixel 5 landscape | phone | 802×293 @2.75x | es-ES | America/Sao_Paulo | dark | — | fast |
| 088 | Pixel 7 | phone | 412×839 @2.625x | en-GB | UTC | dark | reduce | offline-then-online |
| 089 | Desktop Chrome 1280x720 | desktop | 1280×720 @1x | ko-KR | Asia/Seoul | light | — | fast |
| 090 | Desktop Chrome 1920x1080 | desktop | 1920×1080 @1x | en-US | Asia/Kolkata | light | — | slow3g |
| 091 | Desktop Chrome 1366x768 | desktop | 1366×768 @1x | ja-JP | Asia/Tokyo | dark | reduce | fast |
| 092 | Desktop Chrome 1536x864 | desktop | 1536×864 @1x | zh-CN | Asia/Shanghai | dark | — | fast |
| 093 | Desktop Chrome HiDPI 2560x1440 | desktop | 2560×1440 @2x | de-DE | Australia/Sydney | light | — | fast |
| 094 | Desktop Edge 1440x900 | desktop | 1440×900 @1x | fr-FR | Europe/Berlin | light | reduce | fast |
| 095 | Desktop Edge HiDPI 1280x800 | desktop | 1280×800 @2x | es-ES | Pacific/Auckland | dark | — | slow3g |
| 096 | Desktop Firefox 1600x900 | desktop | 1600×900 @1x | en-GB | America/New_York | dark | — | fast |
| 097 | Desktop Firefox HiDPI 1024x768 | desktop | 1024×768 @2x | ko-KR | America/Los_Angeles | light | reduce | fast |
| 098 | Desktop Safari 1440x900 | desktop | 1440×900 @2x | en-US | America/Sao_Paulo | light | — | offline-then-online |
| 099 | Desktop Safari 1680x1050 | desktop | 1680×1050 @2x | ja-JP | UTC | dark | — | fast |
| 100 | Desktop Chrome 1100x700 | desktop | 1100×700 @1x | zh-CN | Asia/Seoul | dark | reduce | slow3g |


## 4. Bugs found and fixed

| # | Found by | Symptom | Root cause | Fix (file) |
|---|---|---|---|---|
| BUG-01 | ocr.qa (186/2,000 cards) | `"Jane Doe, CEO, Founder"` gave jobTitle `"CEO Founder"`, and `"홍길동 \| 마케팅팀 \| 팀장"` gave `"마케팅팀 팀장"`. Neither string is on the card, which violates CLAUDE.md rule 6. | The title was re-joined from the split parts with `" "`. | The title is now the literal slice spanning the title parts. A department part is split out on its own. (`packages/domain/src/ocrParser.ts`) |
| BUG-02 | ocr.qa (265 cards) | Tokyo/Osaka numbers such as `+81 3-1234-5678` were never extracted. | `PHONE_RE` required an area code of at least 2 digits. | Allow 1–4 digit area codes (the existing ≥ 8-digit guard stays). (`ocrParser.ts`) |
| BUG-03 | ocr.qa badges (33/400) | On ja/zh badges the badge-type line `연사` / `참관객` was stored as the person's **fullName**. | The fallback reused the card parser's name guess, which treats a 2-syllable Hangul word as a Korean name, without excluding the type line. | Exclude the badge-type line from the fallback. (`packages/domain/src/badge.ts`) |
| BUG-04 | redact.qa (227/1,400) | Full-width phone numbers (`０１０－１２３４－５６７８`, common from CJK IMEs) passed through `redact()` into logs and analytics. | `\d` and `-` only matched ASCII. | `\p{Nd}` plus full-width separators, and NFKC before keeping the last 2 digits. (`packages/domain/src/redact.ts`; `sanitizeProps` benefits too) |
| BUG-05 | normalize.qa | `+82 010-1234-5678` normalized to `+8201012345678`, so F-020 duplicate detection missed it against `010-1234-5678`. US `1 (415)…` became `+11415…`. Full-width digits gave `null`. | No trunk-prefix handling after the country code; the NANP trunk was not stripped; no NFKC. | 41-country `PHONE_COUNTRIES` table with trunk prefixes. Drop a `0` trunk after the country code (Italy keeps its 0). NANP/RU trunk only before a full national number. NFKC first. (`packages/domain/src/normalize.ts`) |
| BUG-06 | formats.qa (249/500) | A bare CR in a contact field split the vCard line, so `"Eve\rEMAIL:attacker@…"` injected an `EMAIL` property into exported .vcf files. | `esc()` escaped `\n` but not `\r`. | Escape `\r\n`, `\r` and `\n`. (`packages/domain/src/vcard.ts`) |
| BUG-07 | formats.qa (254/400) | The same CR injection existed in ICS: `SUMMARY:Hi\rATTENDEE:mailto:evil@…`. | `icsEscape` only handled `\r?\n`. | Same fix. (`packages/domain/src/ics.ts`) |
| BUG-08 | formats.qa SSRF table | Webhook URLs `https://localhost./`, `https://[::ffff:127.0.0.1]/` and `[::ffff:a9fe:a9fe]` (cloud metadata) were accepted. | The trailing-dot host was not normalized. WHATWG URL serializes mapped IPv4 in hex (`::ffff:7f00:1`), but the check only knew the dotted form. | Strip trailing dots. Decode IPv4-mapped, IPv4-compatible and NAT64 addresses in dotted and hex form. (`packages/domain/src/webhook.ts`) The DNS-resolution check at delivery time already existed. |
| BUG-09 | rbac.qa (16 cases) | `ssoEnforcementDecision` allowed e-mail OTP, Google and passkey for `kim@acme.com.` and `" kim@acme.com "`, even though `assertSsoAllowed` found the SSO-required org for those spellings. | Two different domain parsers: the service used `emailDomain()`, the decision used a raw `slice`. Current callers normalize e-mails first, so this was latent (defense in depth). | The decision now uses `emailDomain()`. (`packages/domain/src/sso.ts`) |
| BUG-10 | offline.qa simulation (213/300 sessions lost data without the fix) | A PATCH queued while an earlier PATCH for the same contact was in flight was merged into that record and then deleted with the first response, losing the edit. Or it was retried with the old Idempotency-Key and a different body, and the server answered `409 idempotency_key_reused`, leaving the item failed. | `enqueue()` coalesced into the in-flight record and kept its key. The flush deleted or overwrote by id without re-reading. `queueRequest` could also persist the wrong record when an older attempted PATCH existed. | Coalesced records take the new write's key. A new pure `settle()` re-reads the stored record and keeps it if it changed in flight. `queueRequest` persists the object `enqueue` actually changed. (`packages/domain/src/offlineQueue.ts`, `apps/web/src/lib/offline.ts`) The existing test that asserted the old key (`track-c.test.ts`) was updated to the corrected contract. |
| BUG-11 | misc.qa | `fmt("{constructor}")` rendered `function Object() { [native code] }`. | `k in vars` walked the prototype chain. | Use an own-property check. (`packages/domain/src/i18n.ts`) |
| BUG-12 | qa-api (63 ops) | Every id-taking endpoint answered **500 internal_error** for a malformed id, e.g. `GET /api/v1/contacts/not-a-uuid`. Postgres raised `22P02 invalid input syntax for type uuid`. | Ids were never validated before the cast, and DB errors fell through to the generic 500. | `mapInputError()` maps 22P02 on uuid to 404, and 22P02/22007/22008 otherwise to 400. Applied in `q()`, in `tx()`, and as a last resort in the web `errorResponse`. (`services/api/src/lib/db.ts`, `apps/web/src/lib/server.ts`) The matrix asserts 404 over HTTP. |
| BUG-13 | qa-api service table | `mergeContact(x, x)` succeeded and set `merged_into_id = id`. The contact vanished from every list. | No same-id guard. | `400 same_contact`. (`services/api/src/modules/relationship.ts`) |
| BUG-14 | matrix design + misc.qa catalog check | On the guest landing for en/ja visitors, the whole capture step was Korean-only (the "직접 입력할게요" button, hints, errors). An offline send showed the Korean-only client message. F-177 requires a foreign recipient to understand the screen before signup. | `CardScanner` had hard-coded Korean strings, and the client network error was not localized. | `SCANNER_MESSAGES` (ko/en/ja) and `GuestMessages.networkError` in the domain i18n. `CardScanner` takes `locale` (ja defaults OCR to jpn+eng). `GuestFlow` passes the locale and maps `network_error`. (`packages/domain/src/i18n.ts`, `apps/web/src/components/CardScanner.tsx`, `apps/web/src/app/x/[token]/GuestFlow.tsx`) |

## 5. Product decisions observed (documented, not changed)

- **Unsupported locales fall back to Korean.** `pickLocale` returns `ko` (`DEFAULT_LOCALE`) when Accept-Language has
  no ko/en/ja tag. A zh-CN or de-DE-only browser gets Korean. Real browsers usually append `en`, which then wins. An
  English fallback for non-Korean regions would be a product call.
- **Card-image listing returns an empty list for another user's contact.** `files.contactCardImages` answers
  `{ images: [] }` instead of 404. It is owner-scoped and leaks nothing; the API QA accepts an empty result for this
  op only.
- **Japanese mobiles are classified as phone, not mobile.** OCR labels Japanese `090/080/070` mobiles as `phone`
  (the unlabeled mobile heuristic is Korean-only). They are still extracted and grounded.
- **Badge names in ja/zh are not detected.** The badge name heuristic (`nameLike`) only knows Hangul and Latin names,
  so ja/zh badges fall back to the card parser.
- **The parser is super-linear on extremely long lines.** `parseBusinessCard` takes about 6 s on a single
  50,000-character line. The API caps OCR input at 120 lines × 500 chars, which parses in milliseconds; the QA case
  uses that cap.

## 6. Limitations

- **Chromium only.** WebKit and Firefox descriptors are emulated in Chromium: viewport, DPR, touch and user agent are
  real, but engine-specific bugs are not covered.
- **Throttling and offline simulation.** Slow 3G is CDP throttling, not packet loss. "Offline" is
  `context.setOffline`. Service-worker background sync is not exercised by the matrix; the outbox logic is covered by
  the domain simulation.
- **Offline outbox race.** `apps/web/src/lib/offline.ts` still has a small window between `settle()`'s re-read and
  its write. IndexedDB transactions cannot span WebCrypto awaits, so a PATCH coalesced in that window can still be
  overwritten. A Web-Locks-wrapped `queueRequest` would close it.
- **Untranslated strings.** OCR progress labels from `apps/web/src/lib/ocr.ts`, and server error messages returned by
  the API, are still Korean on en/ja guest screens.
- **Matrix assumptions.** The matrix shares a database with the API suites. It creates about 100 users per run and
  expects `OTP_DEV_ECHO=1`. Right after a full matrix run, one `pnpm --filter @linkos/api test` run had 5 failures in
  the pre-existing `track-b` suite; two immediate reruns, and `track-b` on its own, passed. This looks like that
  suite being sensitive to leftover rows/outbox backlog in a shared DB, not a regression from this change. Use a
  dedicated DB per job (CI does).
