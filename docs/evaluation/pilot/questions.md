# Learning questions

Allow three minutes for each baseline and post-condition set. Use plain-language
answers. Do not show the rubric or static answers before the response. Use the same
question text for a participant's baseline and post-condition response. Record prior
familiarity, because the second incident can benefit from the first condition.

## Background

Record experience with Linux shell, nginx, DNS, databases and production incident
response on 0 to 3 scales: none, basic study, practical use, incident experience.
Ask whether the participant has seen either OpsReplay incident before. Record yes,
no or unsure. Do not use this as a skill score.

## Upstream baseline and post questions

1. A proxy returns 502 after an application port change. What two pieces of evidence
   would you compare to locate the fault? Explain what the comparison can establish.
2. Explain the chain from a stale proxy port to a failed user request.
3. Your edited proxy configuration fails validation. What do you do next, and why is
   restarting immediately risky?
4. What observation would convince you checkout has recovered? Distinguish one
   successful response from a sustained business operation.

## DNS baseline and post questions

1. The storefront loads but checkout fails after an API address migration. What
   evidence would you compare across DNS, proxy and API?
2. DNS now returns the correct address, but the running proxy still connects to the
   retired address. Explain one plausible reason and the evidence needed to confirm it.
3. DNS cannot resolve the upstream name after your zone edit. What action order avoids
   making the storefront outage larger?
4. What observation would convince you checkout has recovered? Explain why a correct
   DNS answer alone is insufficient.

## Transfer after upstream study

A payments proxy targets port 9091. The service moved to 9090. The error log shows
connection refusal at 9091 and the socket list shows 9090. An engineer edits the proxy
file but the syntax check fails. Explain the diagnosis and a safe recovery plan.
State the evidence that would confirm recovery.

## Transfer after DNS study

A search API moved from `10.0.0.8` to `10.0.0.9`. DNS now returns the new address.
The proxy error log still shows refused connections to the old address. A proposed DNS
zone change is invalid. Explain the likely failure chain, a safe action order and the
evidence that would confirm recovery. Do not assume the service has recovered from
the DNS answer alone.

These transfer cases change service names and values but retain the mechanism. They
test near transfer, not broad troubleshooting ability. They are given after their
matching condition with no access to the study sheet or application.
