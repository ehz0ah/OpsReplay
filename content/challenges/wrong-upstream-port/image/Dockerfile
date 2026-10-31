FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587 AS debian

# Retrieve fixed editor source through signed APT indexes. Binary dependencies
# stay on Bookworm; no sid binary repository is configured.
FROM debian AS vim-source
WORKDIR /build
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates \
    && printf '%s\n' 'deb-src https://deb.debian.org/debian sid main' > /etc/apt/sources.list.d/vim-source.list \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends dpkg-dev vim-tiny \
    && apt-get source vim=2:9.2.0858-1 \
    && printf '%s\n' '6467695560a7a13dd2298584711f7d75623b2211f8ff7b663b16a492762791cf  vim_9.2.0858.orig.tar.xz' | sha256sum -c -

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
COPY --from=vim-build /build/vim-tiny-security.deb /build/vim-common-security.deb /tmp/
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y --no-install-recommends \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       ca-certificates curl gunicorn iproute2 less nano nginx postgresql-15 \
       procps python3-flask python3-psycopg2 supervisor vim-tiny \
    && dpkg -i /tmp/vim-common-security.deb /tmp/vim-tiny-security.deb \
    && rm /tmp/vim-common-security.deb /tmp/vim-tiny-security.deb \
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
