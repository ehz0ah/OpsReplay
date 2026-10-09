FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS base
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y --no-install-recommends \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

FROM base AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY packages/contracts/schemas/ packages/contracts/schemas/
COPY packages/contracts/private/ packages/contracts/private/
COPY apps/monitor/src/ apps/monitor/src/
COPY apps/monitor/test/control-client.ts apps/monitor/test/control-client.ts
COPY scripts/build-monitor.mjs scripts/build-monitor.mjs
RUN node scripts/build-monitor.mjs

# Runtime image. The Challenge manifest and credentials are supplied at launch.
FROM base AS runtime-base
WORKDIR /app
COPY --from=build /build/dist/monitor/runtime.cjs /app/runtime.cjs
USER node
EXPOSE 9443
ENTRYPOINT ["node", "/app/runtime.cjs"]
CMD ["/app/challenge.json"]

# Local integration image. Test-only files never enter the runtime target.
FROM runtime-base AS test
COPY --from=build /build/dist/monitor/client.cjs /app/client.cjs
COPY content/challenges/wrong-upstream-port/challenge.json /app/challenge.json

FROM runtime-base AS runtime
