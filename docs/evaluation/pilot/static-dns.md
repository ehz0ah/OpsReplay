# Static incident: checkout fails after API migration

This is original synthetic training material for `stale-dns-record` version 0.1.2.
It is a study sheet, not a recorded production incident.

## Alert and system

The storefront home page loads, but checkout returns 502 after the API moved. nginx
listens on port 80 and routes checkout to `api.internal:8080`. CoreDNS answers that
internal name. The shop API now listens on `127.0.0.2:8080` and writes orders to
PostgreSQL.

## Evidence

The nginx error log reports refused upstream connections to `127.0.0.3:8080`.
`dig api.internal` returns `127.0.0.3`. The socket list shows the API listening at
`127.0.0.2:8080`. The CoreDNS zone still has the retired A record:

```text
api IN A 127.0.0.3
```

nginx resolved the name when it started. It keeps that address until a successful
reload or start. Changing DNS alone does not replace nginx's running resolution.

## Action and consequence

Correct the A record and zone serial, reload the valid zone, then confirm its answer.
An invalid zone fails to load and the name becomes unresolvable. A nginx reload at
that point fails but keeps the running workers and storefront. Restarting nginx first
stops those workers. It then cannot start because the upstream name is unresolvable,
so the whole storefront goes offline.

The risk is the unresolved name during restart, not a rule that DNS fixes always require
the same command sequence.

## Recovery and causal explanation

Restore a valid record and confirm name resolution before applying the proxy change:

```sh
sed -i -e 's/127\.0\.0\.3/127.0.0.2/' -e 's/2026090101 ; serial/2026090102 ; serial/' /etc/coredns/internal.db
service coredns restart
dig api.internal
nginx -t
nginx -s reload
```

If nginx was stopped, validate before starting it. Check checkout through the proxy,
including creation and reading of the saved order. Recovery requires 60 consecutive
seconds of passing checks. A correct DNS answer does not prove the proxy has refreshed
its resolution or that checkout is recovered.

The chain is: API address moved, DNS stayed old, nginx retained the retired address,
and checkout connections failed. Correcting DNS plus successful proxy reload restores
the path. Use evidence from both name resolution and actual service listeners.
