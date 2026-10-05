FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251

ENV LANG=C.UTF-8 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    EDITOR=nano \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/lib/postgresql/15/bin

COPY --chmod=755 rootfs/usr/sbin/policy-rc.d /usr/sbin/policy-rc.d
COPY rootfs/etc/postgresql-common/createcluster.conf /etc/postgresql-common/createcluster.conf
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       ca-certificates curl gunicorn iproute2 less nano nginx postgresql-15 \
       procps python3-flask python3-psycopg2 supervisor vim-tiny \
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
