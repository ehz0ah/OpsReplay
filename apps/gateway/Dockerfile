FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY packages/contracts/schemas/ packages/contracts/schemas/
COPY packages/contracts/private/ packages/contracts/private/
COPY apps/gateway/src/ apps/gateway/src/
COPY scripts/build-gateway.mjs scripts/build-gateway.mjs
RUN node scripts/build-gateway.mjs

FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS runtime
WORKDIR /app
COPY --from=build /build/dist/gateway/runtime.cjs /app/runtime.cjs
USER node
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "/app/runtime.cjs"]
