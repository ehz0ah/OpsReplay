# Code Review content

The original `proxy-rollout` Free exercise and `pool-settings` Pro exercise are
synthetic drafts. No review content is published on AWS. Each private bundle has
a diff, context, access plan, and reference findings. The API returns the public
exercise before submission and releases findings only after the result is saved.

Follow the [authoring guide](../../docs/content-authoring.md). Run
`npm run review:publish -- --prepare FILE` to inspect a draft's public projection.
After independent content review, an authorised operator can use
`npm run review:publish -- --apply FILE TABLE REGION`. Publication requires
content GetItem/PutItem/ConditionCheckItem permissions and is separate from a build.
