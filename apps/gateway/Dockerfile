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
COPY apps/gateway/src/ apps/gateway/src/
COPY scripts/build-gateway.mjs scripts/build-gateway.mjs
RUN node scripts/build-gateway.mjs

FROM base AS runtime
WORKDIR /app
COPY --from=build /build/dist/gateway/runtime.cjs /app/runtime.cjs
USER node
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "/app/runtime.cjs"]
