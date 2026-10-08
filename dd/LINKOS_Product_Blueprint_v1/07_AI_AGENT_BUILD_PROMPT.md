# LINKOS Master Build Prompt for an AI Coding Agent

You are the principal engineer responsible for implementing the complete LINKOS platform described in this bundle. The feature registry is the source of truth. Do not omit, silently merge, rename away, or defer any Feature ID.

## Required workflow
1. Read `03_FEATURE_REGISTRY.yaml`, `04_OPENAPI.yaml`, `05_DATABASE_SCHEMA.sql`, `06_EVENT_CATALOG.yaml`, and the whitepaper.
2. Generate `TRACEABILITY.md` mapping every Feature ID to: UI route/component, API operation, service/module, tables, event(s), unit tests, integration tests, E2E tests, deployment status.
3. Build a monorepo with `apps/web`, `apps/mobile`, `apps/ios-app-clip`, `services/api`, `services/ai-worker`, `packages/ui`, `packages/contracts`, `packages/config`, `infra`.
4. Use strict TypeScript for web/API/mobile contracts. Use Python only for AI/STT/OCR worker workloads where justified.
5. Implement as a modular monolith first with clean service boundaries and transactional outbox; split services only when operational metrics justify it.
6. Implement zero-friction exchange first-class: no sign-up wall for recipients. The recipient can view sender data, scan their own paper business card, explicitly approve fields, complete reciprocal exchange, and claim the resulting identity afterward.
7. Handoff channel order is adaptive, not hardcoded by marketing language. App-to-app foreground BLE proximity is allowed for installed users. For non-users, prefer OS-native share of an ephemeral HTTPS URL and/or an NFC accessory. Android must use the web/PWA path rather than Google Play Instant. QR is the final universal fallback and must appear automatically after earlier channels fail or time out.
8. Never claim browser-to-browser NFC peer transfer. Web NFC is tag-oriented and limited availability. Never require Web Bluetooth on iOS Safari.
9. All exchange tokens contain no plaintext PII, use >=128 bits entropy, expire, are rate-limited, and support revocation.
10. AI extraction must never invent factual contact fields. Persist provenance and confidence. AI-inferred Offer/Need/Match facts must be visibly labeled and confirmable.
11. Recording/transcription cannot start without configured consent UX and consent record.
12. Every external integration is idempotent, retryable, observable, and stores external ID/version mapping. Google People API mutations for the same user should be serialized.
13. Complete security, privacy, accessibility, i18n, observability, backup, offline sync, rate limits, and deletion/export workflows before production-ready status.

## Definition of done
- 100% of Feature IDs have green traceability entries.
- All P0 and P1 features have passing E2E tests.
- No PII in exchange token, logs, analytics payloads unless explicitly allowed.
- Mobile, Safari iOS, Chrome Android, Chrome/Edge desktop regression suite passes.
- Google Contacts, Gmail, Drive/Sheets, Calendar integrations pass sandbox verification.
- OCR confidence review, duplicate merge, guest claim, Living Card, Meeting Card, Relationship Memory, Need↔Offer Match, Connection Room, event networking, export, and enterprise RBAC all pass acceptance tests.
- Pen-test findings rated Critical/High are zero at launch.
- Disaster recovery restore test passes.

Produce working code, infrastructure definitions, migrations, seed data, tests, API docs, and deployment runbooks. Update `TRACEABILITY.md` continuously.
