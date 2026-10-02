# Contract examples

These JSON examples are synthetic fixtures for schema validation and frontend work. They
are not captured sessions.

Most examples describe one first attempt of the Wrong upstream port Challenge. The
learner reads the proxy error log, checks listening sockets, edits `nginx.conf` with a
syntax error, and restarts nginx, which takes the proxy down. They then validate the
configuration, start nginx, and recover. The [timeline](timeline.json),
[debrief](debrief.json), and [playback](playback.json) agree, and `npm run check`
re-derives the debrief and highlights from the timeline and manifest.
The empty editor output records an attempted check, not observed configuration evidence.
The restart is a possible cause based on its command pattern and timing. The response
examples also include an incomplete recording with no score and an interrupted assistant
turn with no proposal. Playback includes capture intervals, which do not attribute file
changes to one command. Gateway fixtures include uncertain proposal delivery followed
by a recovered acceptance receipt. Neither status means the command succeeded.

The [review submission](review-submission.json) is the result of matching the
[submit request](review-submit-request.json) against the pool settings bundle. The
catalogue shows the wire shape as if the drafts were published. It is not a production
catalogue.
