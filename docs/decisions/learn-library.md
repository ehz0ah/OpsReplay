# Learn library increment

Free lessons are built from original Markdown into sanitised JSON assets. Pro bodies
remain in private content storage. Metadata uses strict YAML without aliases. The
same public LearnEntry schema validates both paths. Source links use HTTPS.

Publication stores an immutable content object before atomically publishing its
reference and catalogue metadata. A matching retry is safe. This first increment
rejects replacement of an already published lesson ID; version replacement needs a
separate publication decision. No content is published by a build or deployment.

The GET Learn action is separate, authenticated, and has read-only access to the
published lesson reference, current plan, and content prefix. Free pages use static
assets without authentication. Pro entitlement is checked before the private body
read. Object length, hash, identity, and sanitised HTML are checked before response.

The web library uses the existing Mantine controls and typography. Lessons link to
original sources and related practice. Private exercise findings and Challenge
manifests never enter a lesson response or the web build.

Local content, DynamoDB transaction, API, browser contract, and CDK tests verify these
boundaries. AWS publication, Cognito admission and cloud delivery remain untested.
