# Static incident: storefront returns 502

This is original synthetic training material for `wrong-upstream-port` version 0.1.2.
It is a study sheet, not a recorded production incident.

## Alert and system

After an application change, checkout requests return 502 Bad Gateway. nginx listens
on port 80 and proxies requests to the shop API. The API writes orders to PostgreSQL.
The incident affects the proxy-to-API path. A 502 response alone does not locate its
cause.

## Evidence

The nginx error log reports refused connections to `127.0.0.1:8081`. The socket list
shows the shop listening on `127.0.0.1:8080`. The configuration contains:

```nginx
proxy_pass http://127.0.0.1:8081;
```

The upstream points at a port where nothing listens. A direct API request can succeed
while requests through nginx fail. Database availability does not repair that mismatch.

## Action and consequence

Correcting the upstream to port 8080 can restore the route. An edit that removes the
semicolon produces invalid nginx syntax. `nginx -t` reports failure. A reload with that
invalid file is rejected while the running workers continue. Restarting stops the
running proxy before the replacement starts. The replacement cannot read the invalid
configuration, so refused connections replace the earlier 502 responses.

Do not infer that every restart is harmful. Here the risk depends on the invalid file
and nginx's stop/start behaviour.

## Recovery and causal explanation

Set the correct upstream, validate the result, then reload:

```sh
sed -i 's#proxy_pass http://127.0.0.1:8081;#proxy_pass http://127.0.0.1:8080;#' /etc/nginx/nginx.conf
nginx -t
nginx -s reload
```

If the proxy is already stopped, validate before starting it. Verify checkout through
the proxy, including order creation and reading the saved order. The training recovery
check requires 60 consecutive seconds of successful checks. A single successful request
is insufficient.

The chain is: application port changed, proxy configuration stayed old, upstream
connections were refused, and nginx returned 502. Compare symptoms, actual listeners
and configuration before selecting the action. Describe impact using failed requests
and observed outages rather than an unsupported causal score.
