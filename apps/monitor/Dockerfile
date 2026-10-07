FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY packages/contracts/schemas/ packages/contracts/schemas/
COPY apps/monitor/src/ apps/monitor/src/
COPY apps/monitor/test/control-client.ts apps/monitor/test/control-client.ts
COPY scripts/build-monitor.mjs scripts/build-monitor.mjs
RUN node scripts/build-monitor.mjs

# Runtime image. The Challenge manifest and credentials are supplied at launch.
FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS runtime-base
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
