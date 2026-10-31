FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587 AS debian

# Retrieve the current distribution source through Debian's signed APT indexes.
FROM debian AS vim-source
WORKDIR /build
RUN sed -i 's/^Types: deb$/Types: deb deb-src/' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends dpkg-dev vim-tiny \
    && apt-get source "vim=$(dpkg-query -W -f='${source:Version}' vim-tiny)"

FROM vim-source AS vim-build
RUN DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       gcc autoconf debhelper libacl1-dev libselinux1-dev libncurses-dev
COPY security/ /build/security/
RUN sh /build/security/build-vim-security.sh

FROM debian AS runtime

ENV LANG=C.UTF-8 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    EDITOR=nano \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/lib/postgresql/15/bin

COPY --chmod=755 rootfs/usr/sbin/policy-rc.d /usr/sbin/policy-rc.d
COPY rootfs/etc/postgresql-common/createcluster.conf /etc/postgresql-common/createcluster.conf
COPY --chmod=644 security/retain-vim-provenance.conf /etc/dpkg/dpkg.cfg.d/zz-opsreplay-vim-provenance
COPY --from=vim-build /build/vim-tiny-security.deb /tmp/vim-tiny-security.deb
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y --no-install-recommends \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       ca-certificates curl gunicorn iproute2 less nano nginx postgresql-15 \
       procps python3-flask python3-psycopg2 supervisor vim-tiny \
    && dpkg -i /tmp/vim-tiny-security.deb \
    && rm /tmp/vim-tiny-security.deb \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home --home-dir /var/lib/shop --shell /usr/sbin/nologin shop

COPY rootfs/ /
RUN chmod 755 /usr/local/bin/opsreplay-* /usr/local/sbin/service /usr/sbin/policy-rc.d \
    && ln -s /usr/bin/vim.tiny /usr/local/bin/vim \
    && install -d -o postgres -g postgres -m 700 /var/lib/postgresql/data \
    && install -d -o postgres -g postgres /var/log/postgresql /run/postgresql \
    && install -d -o shop -g shop /var/log/shop \
    && install -d /var/log/nginx /var/log/supervisor

WORKDIR /root
# Learner actions can stop services or change ports without ending the container.
HEALTHCHECK NONE
ENTRYPOINT ["/usr/local/bin/opsreplay-start"]
