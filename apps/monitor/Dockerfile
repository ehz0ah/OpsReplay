FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY packages/contracts/schemas/ packages/contracts/schemas/
COPY apps/monitor/src/ apps/monitor/src/
COPY apps/monitor/test/control-client.ts apps/monitor/test/control-client.ts
COPY apps/monitor/test/driver.ts apps/monitor/test/driver.ts
COPY scripts/build-monitor.mjs scripts/build-monitor.mjs
RUN node scripts/build-monitor.mjs

# Local integration image. Runtime credentials are injected per container.
FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3
WORKDIR /app
COPY --from=build /build/dist/monitor/ /app/
COPY content/challenges/wrong-upstream-port/challenge.json /app/challenge.json
USER node
EXPOSE 9443
ENTRYPOINT ["node", "/app/runtime.cjs"]
CMD ["/app/challenge.json"]
