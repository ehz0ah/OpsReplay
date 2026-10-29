FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS base
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y --no-install-recommends \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*
RUN install -d /runtime-files/var/lib/dpkg/status.d \
    && cp --parents -L /usr/lib/*-linux-gnu/libstdc++.so.6 \
       /usr/lib/*-linux-gnu/libgcc_s.so.1 /usr/share/doc/gcc-12-base/copyright /runtime-files \
    && dpkg-query -s libstdc++6 > /runtime-files/var/lib/dpkg/status.d/libstdc++6 \
    && dpkg-query -s libgcc-s1 > /runtime-files/var/lib/dpkg/status.d/libgcc-s1 \
    && dpkg-query -s gcc-12-base > /runtime-files/var/lib/dpkg/status.d/gcc-12-base

FROM base AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY packages/contracts/schemas/ packages/contracts/schemas/
COPY packages/contracts/private/ packages/contracts/private/
COPY apps/monitor/src/ apps/monitor/src/
COPY apps/monitor/test/control-client.ts apps/monitor/test/capture-image-check.ts apps/monitor/test/
COPY scripts/build-monitor.mjs scripts/build-monitor.mjs
RUN node scripts/build-monitor.mjs

# Runtime image. The Challenge manifest and credentials are supplied at launch.
FROM gcr.io/distroless/base-nossl-debian12:nonroot@sha256:be40c00dfabd86576d92666e87e406714d5618342de1a0c213ad232de255172e AS runtime-base
COPY --from=base /runtime-files/ /
COPY --from=base /usr/local/bin/node /usr/local/bin/node
COPY --from=base /usr/local/LICENSE /usr/share/doc/node/LICENSE
COPY --from=base /etc/passwd /etc/group /etc/
ENV PATH=/usr/local/bin:/usr/bin:/bin
WORKDIR /app
COPY --from=build /build/dist/monitor/runtime.cjs /app/runtime.cjs
USER node
EXPOSE 9443
ENTRYPOINT ["node", "/app/runtime.cjs"]
CMD ["/app/challenge.json"]

# Local integration image. Test-only files never enter the runtime target.
FROM runtime-base AS test
# The FIFO fixture needs mkfifo. These files never enter a runtime target.
COPY --from=base /usr/bin/mkfifo /test-tools/mkfifo
COPY --from=base /usr/lib/*-linux-gnu/libselinux.so.1 /test-tools/lib/
COPY --from=base /usr/lib/*-linux-gnu/libpcre2-8.so.0* /test-tools/lib/
ENV PATH=/test-tools:/usr/local/bin:/usr/bin:/bin \
    LD_LIBRARY_PATH=/test-tools/lib
COPY --from=build /build/dist/monitor/client.cjs /app/client.cjs
COPY --from=build /build/dist/monitor/capture-check.cjs /app/capture-check.cjs
COPY content/challenges/wrong-upstream-port/challenge.json /app/challenge.json

# Candidate reference runtime, not a published Challenge. No test client or credentials.
FROM runtime-base AS reference
COPY --chown=node:node --chmod=444 content/challenges/wrong-upstream-port/challenge.json /app/challenge.json

# Candidate DNS runtime. Shared Monitor implementation, separate private manifest.
FROM runtime-base AS stale-dns
COPY --chown=node:node --chmod=444 content/challenges/stale-dns-record/challenge.json /app/challenge.json

FROM runtime-base AS runtime
