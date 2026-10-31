FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587 AS debian

# Freeze build dependencies and original packages alongside the fixed source.
# Bootstrap CA trust over signed HTTP indexes, then use HTTPS for all archives.
FROM debian AS security-build-base
WORKDIR /build
RUN printf '%s\n' \
       'deb [check-valid-until=no signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] http://snapshot.debian.org/archive/debian/20261031T000000Z/ bookworm main' \
       'deb [check-valid-until=no signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] http://snapshot.debian.org/archive/debian/20261031T000000Z/ bookworm-updates main' \
       'deb [check-valid-until=no signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] http://snapshot.debian.org/archive/debian-security/20261031T000000Z/ bookworm-security main' \
       > /etc/apt/sources.list.d/opsreplay-bookworm.list \
    && rm /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates \
    && sed -i 's|http://snapshot.debian.org/|https://snapshot.debian.org/|g' /etc/apt/sources.list.d/opsreplay-bookworm.list \
    && printf '%s\n' \
       'deb-src [check-valid-until=no signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://snapshot.debian.org/archive/debian/20261031T000000Z/ sid main' \
       > /etc/apt/sources.list.d/opsreplay-sid.list \
    && apt-get update

# Retrieve fixed editor source; no sid binary repository is configured.
FROM security-build-base AS vim-source
RUN DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends dpkg-dev vim-tiny \
    && apt-get source vim=2:9.2.0858-1 \
    && printf '%s\n' '6467695560a7a13dd2298584711f7d75623b2211f8ff7b663b16a492762791cf  vim_9.2.0858.orig.tar.xz' | sha256sum -c -

FROM vim-source AS vim-build
RUN DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       gcc autoconf debhelper libacl1-dev libselinux1-dev libncurses-dev python3
COPY security/ /build/security/
RUN sh /build/security/build-vim-security.sh

# Retrieve only newer source. Build and runtime dependencies stay on Bookworm.
FROM security-build-base AS curl-build
RUN DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       build-essential dpkg-dev curl libcurl4 libssl-dev libkrb5-dev libssh2-1-dev \
       libidn2-dev libpsl-dev libnghttp2-dev libbrotli-dev libzstd-dev zlib1g-dev libldap2-dev \
    && apt-get source curl=8.23.0-1 \
    && printf '%s\n' 'e3de77cfa6367083c776a26647fc9f633b538c06c3baa73d931a252ac8f72b49  curl_8.23.0.orig.tar.gz' | sha256sum -c -
COPY security/build-curl-security.sh /build/security/build-curl-security.sh
RUN sh /build/security/build-curl-security.sh

# Include Debian's fixed zlib source patches without changing the Bookworm ABI.
FROM security-build-base AS zlib-build
RUN DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends build-essential dpkg-dev zlib1g \
    && apt-get source zlib=1:1.3.dfsg+really1.3.2-4 \
    && printf '%s\n' \
       '7b6903eb019983987b7112eccf90f1703f1c6c0e0cede36564bf611d19ca579d  zlib_1.3.dfsg+really1.3.2.orig.tar.gz' \
       'ee9db06d87b2d810b9edd8485b8b39433b18eb30d93f9e1d40fe8dbd40eda7a1  zlib_1.3.dfsg+really1.3.2-4.debian.tar.xz' | sha256sum -c -
COPY security/build-zlib-security.sh /build/security/build-zlib-security.sh
RUN sh /build/security/build-zlib-security.sh

# Rebuild the matching utilities and shared libraries with Bookworm dependencies.
FROM security-build-base AS util-linux-build
RUN DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       bsdutils util-linux util-linux-extra mount libblkid1 libmount1 libsmartcols1 libuuid1 \
       build-essential dpkg-dev pkg-config python3 libtool autoconf automake gettext autopoint \
       libaudit-dev libcap-ng-dev libcrypt-dev libncurses-dev libpam0g-dev \
       libreadline-dev libselinux1-dev libsystemd-dev libudev-dev \
       libcryptsetup-dev zlib1g-dev bison flex \
    && apt-get source util-linux=2.42.4-1 \
    && printf '%s\n' \
       'fbd62a100ab7bb8746ba0661255c3c48185b1e9021507c624da01fbc696330ec  util-linux_2.42.4.orig.tar.xz' \
       'a00f3ceaff58a4e2d1591c620ee5d7c8bcd435fd2cbd86db604d7b6c8e19b8c9  util-linux_2.42.4-1.debian.tar.xz' | sha256sum -c -
COPY security/build-util-linux-security.sh security/repack-util-linux.py /build/security/
RUN sh /build/security/build-util-linux-security.sh

# Backport the proposed gettext lookup restriction to the exact Bookworm libc.
FROM security-build-base AS glibc-build
RUN printf '%s\n' \
       'deb-src [check-valid-until=no signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://snapshot.debian.org/archive/debian/20261031T000000Z/ bookworm main' \
       > /etc/apt/sources.list.d/opsreplay-glibc-source.list \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       build-essential dpkg-dev debhelper gettext gawk bison python3 file quilt \
       autoconf gperf linux-libc-dev libgd-dev libaudit-dev libselinux1-dev libcap-dev \
    && apt-get source glibc=2.36-9+deb12u14 \
    && printf '%s\n' \
       'a543c02070d46ccaf866957efd13f10c924daa74c86a90a0254db09a92a708ee  glibc_2.36.orig.tar.xz' \
       'cf4ac9cd98185452cae3ef34e2e4ee12753e3d93fd0c62c61396d4a47eec902f  glibc_2.36-9+deb12u14.debian.tar.xz' | sha256sum -c -
COPY security/build-glibc-security.sh security/gettext-path-restriction.patch security/gettext-compatibility.c \
     security/loader-path-normalization.patch security/loader-path-compatibility.c /build/security/
RUN sh /build/security/build-glibc-security.sh

FROM debian AS runtime

ENV LANG=C.UTF-8 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    EDITOR=nano \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/lib/postgresql/15/bin

COPY --chmod=755 rootfs/usr/sbin/policy-rc.d /usr/sbin/policy-rc.d
COPY rootfs/etc/postgresql-common/createcluster.conf /etc/postgresql-common/createcluster.conf
COPY --chmod=644 security/retain-vim-provenance.conf /etc/dpkg/dpkg.cfg.d/zz-opsreplay-vim-provenance
COPY --chmod=644 security/retain-curl-provenance.conf /etc/dpkg/dpkg.cfg.d/zz-opsreplay-curl-provenance
COPY --chmod=644 security/retain-zlib-provenance.conf /etc/dpkg/dpkg.cfg.d/zz-opsreplay-zlib-provenance
COPY --from=vim-build /build/vim-retain-files.conf /etc/dpkg/dpkg.cfg.d/zz-opsreplay-vim-files
COPY --from=vim-build /build/vim-tiny-security.deb /build/vim-common-security.deb /tmp/
COPY --from=curl-build /build/curl-security.deb /build/libcurl4-security.deb /tmp/
COPY --from=zlib-build /build/zlib1g-security.deb /tmp/
COPY --from=util-linux-build /build/util-linux-retain-files.conf /etc/dpkg/dpkg.cfg.d/zz-opsreplay-util-linux-files
COPY --from=util-linux-build /build/util-linux-packages/ /tmp/util-linux-packages/
COPY --from=glibc-build /build/libc6-security.deb /tmp/
COPY --from=glibc-build /build/glibc-retain-files.conf /etc/dpkg/dpkg.cfg.d/zz-opsreplay-glibc-files
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y --no-install-recommends \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       ca-certificates curl gunicorn iproute2 less nano nginx postgresql-15 \
       procps python3-flask python3-psycopg2 supervisor vim-tiny \
    && test "$(dpkg-query -W -f='${Version}' libc6)" = '2.36-9+deb12u14' \
    && dpkg -i /tmp/libc6-security.deb \
    && dpkg -i /tmp/util-linux-packages/*.deb \
    && dpkg -i /tmp/zlib1g-security.deb /tmp/libcurl4-security.deb /tmp/curl-security.deb /tmp/vim-common-security.deb /tmp/vim-tiny-security.deb \
    && rm -r /tmp/util-linux-packages \
    && rm /tmp/libc6-security.deb /tmp/zlib1g-security.deb /tmp/libcurl4-security.deb /tmp/curl-security.deb /tmp/vim-common-security.deb /tmp/vim-tiny-security.deb \
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
