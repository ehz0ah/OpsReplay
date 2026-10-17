ARG CHALLENGE_BASE
FROM coredns/coredns:1.13.1@sha256:9b9128672209474da07c91439bf15ed704ae05ad918dd6454e5b6ae14e35fee6 AS dns
FROM ${CHALLENGE_BASE} AS runtime
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends dnsutils \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY --from=dns /coredns /usr/local/bin/coredns
COPY rootfs/ /
RUN chmod 755 /usr/local/bin/opsreplay-* /usr/local/sbin/service \
    && install -d /var/log/coredns
ENTRYPOINT ["/usr/local/bin/opsreplay-dns-start"]
