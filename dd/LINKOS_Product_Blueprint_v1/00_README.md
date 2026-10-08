# LINKOS Product Blueprint v1

This bundle is a build-ready technical specification for a Business Identity & Relationship OS.

Feature count: **197**

Files:
- `LINKOS_기술백서_상용화_아키텍처_v1.docx`: human-readable master whitepaper
- `03_FEATURE_REGISTRY.yaml`: machine-readable source of truth
- `04_OPENAPI.yaml`: API blueprint
- `05_DATABASE_SCHEMA.sql`: core relational schema
- `06_EVENT_CATALOG.yaml`: asynchronous domain event contract
- `07_AI_AGENT_BUILD_PROMPT.md`: master prompt for coding agent
- `08_ACCEPTANCE_TEST_MATRIX.csv`: feature traceability and acceptance matrix
- `09_REPO_STRUCTURE.txt`: recommended monorepo layout
- `diagrams/`: architecture source/PNG diagrams

Important product rule: recipient acquisition must not be blocked by account creation. Exchange first; account claim second. QR is the final fallback, not the default.
