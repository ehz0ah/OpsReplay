# Wrong upstream port: local image

This implements the service stack in [the draft manifest](challenge.json), not a
complete Challenge session. There is no monitor, terminal server, gateway, or AWS
deployment. The manifest remains unpublished.

## Build and enter

From the repository root, with Docker running:

```sh
docker build -t opsreplay/challenge-wrong-upstream-port:dev content/challenges/wrong-upstream-port/image
sh content/challenges/wrong-upstream-port/run-local.sh opsreplay-port
docker exec opsreplay-port opsreplay-check-startup
```

If the check reports a missing listener, wait briefly and run it again. Once it
succeeds, enter the container:

```sh
docker exec -it opsreplay-port bash
```

This checks the initial service listeners, not successful checkout. The initial 502
is intentional. Run it only before learner access. There is no continuous Docker
health check. Stopping a service or changing its port must not end the container.

The container includes `nano`, `vi` / `vim` (Vim tiny), `curl`, `ss`, `ps`, `less`,
and `psql`. Inspect the real services and logs:

```sh
curl -i http://127.0.0.1/
tail /var/log/nginx/error.log
ss -ltnp
service nginx status
```

There is no background traffic yet. Requests made with `curl` generate real logs.
nginx listens on port 80, the shop on loopback port 8080, and PostgreSQL on loopback
port 5432. The shop provides `GET /`, `POST /api/checkout`, and `GET /api/orders/<id>`.
Checkout accepts an optional JSON `reference` and returns a stored, confirmed order.

## Reference repair

Inside the container:

```sh
sed -i 's#proxy_pass http://127.0.0.1:8081;#proxy_pass http://127.0.0.1:8080;#' /etc/nginx/nginx.conf
nginx -t
nginx -s reload
curl --json '{"reference":"local-check"}' http://127.0.0.1/api/checkout
```

Reload is asynchronous. A request can still receive 502 while the old workers exit.
If this happens, wait briefly and try the request again.

Changing the application's listening port to 8081 is also a valid repair. Recovery
depends on working checkout, not on using the reference commands.

Use the returned ID with `GET /api/orders/<id>`. nginx, shop, and postgres support
`service <name> start|stop|restart|reload|status`. These commands control Supervisor,
not systemd. Stopped services are not automatically restarted. A restart with invalid
nginx configuration stops the proxy. A failed reload keeps its current workers.

`service shop reload` rereads `gunicorn.conf.py`, but does not reload `shop.env`.
After changing `shop.env`, use `service shop restart` to apply the new environment.

## Storage and cleanup

Files and database data stay in this container's writable layer. Restarting a service
or this same container preserves edits and orders. Creating a new container restores
the original fault and empty database. Interrupted database initialisation requires a
fresh container. Shared watched-file volumes are deferred to monitor integration.

After leaving the shell, discard this local attempt and its edits:

```sh
docker rm -f opsreplay-port
```

The run script has no internet route, published ports, host mounts, or Docker socket.
It uses 1 CPU, 2 GiB memory with swap disabled, 128 PIDs, and no-new-privileges. It drops `NET_RAW`,
`MKNOD`, `AUDIT_WRITE`, `SETFCAP`, `SETPCAP`, `SYS_CHROOT`, and `FSETID` from Docker's
defaults. Remaining defaults support service user changes, file ownership, signals,
and port 80. This is a local development setup, not proof of Fargate isolation.

The Debian base image is pinned by multi-platform digest. Debian packages are resolved
at build time, so clean rebuilds can receive security updates. There are no embedded
platform credentials. Any local process can connect to the `shop` database as `shop`
over loopback without a password. Local administration uses peer authentication.

## Automated image checks

From the repository root, with Docker and Node 22:

```sh
npm run challenge:build
npm run challenge:test
```

The tests start fresh containers with the same run script and execute the manifest's
reference fix, trap, and safe alternative through `docker exec`. They verify real HTTP
responses, stored orders, service and container restarts, fresh-attempt reset, and local
runtime restrictions. Each test removes its containers and data, including on failure.
The suite makes a bounded number of requests and keeps no database volumes. Set
`OPSREPLAY_CHALLENGE_IMAGE` to test a different already-built image reference.

These are image integration checks, not the full publication harness. They do not prove
60-second sustained recovery, monitor isolation, recording, playback, or Fargate behaviour.
