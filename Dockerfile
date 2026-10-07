# LINKOS production image: Next.js standalone web/API + migration runner + outbox worker
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY packages/domain/package.json packages/domain/
COPY services/api/package.json services/api/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @linkos/web build

FROM base AS runtime
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
RUN groupadd -r app && useradd -r -g app app
WORKDIR /app
# web (standalone server)
COPY --from=build --chown=app:app /repo/apps/web/.next/standalone ./
COPY --from=build --chown=app:app /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=app:app /repo/apps/web/public ./apps/web/public
# migrations + worker (run with tsx)
COPY --from=build --chown=app:app /repo/db ./ops/db
COPY --from=build --chown=app:app /repo/services ./ops/services
COPY --from=build --chown=app:app /repo/packages ./ops/packages
COPY --from=build --chown=app:app /repo/node_modules ./ops/node_modules
COPY --from=build --chown=app:app /repo/package.json /repo/tsconfig.base.json ./ops/
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# default: web. Override with ["migrate"] or ["worker"].
COPY --chown=app:app infra/entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
CMD ["web"]
