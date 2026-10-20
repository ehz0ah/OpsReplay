# Formative learner study

This package supports the planned 5 to 10 person pilot. It is a protocol and blank
materials, not evidence of learning benefit. Do not start recruitment sessions until
the integrated AWS checkpoint and participant deletion path pass.

It makes the [evaluation plan](../../evaluation.md) executable. The study owner resolves
the local contact and deletion date before consent; these are not invented by this
public package.

## Study question and limits

Can learners use OpsReplay's investigation, debrief and playback to explain a failure
and choose a safer recovery? Compare the complete workflow with static study material
for the other incident. The assistant stays off for both core conditions.

The current upstream Challenge is Easy and DNS is Medium. They are not matched in
difficulty. Use all four assignments, record experience and assignment, and report
results separately by incident and condition. Counterbalancing reduces order effects;
it does not remove incident difficulty or learning carryover. Do not present a small
paired difference as a causal effectiveness estimate or as playback's separate effect.

## Files

| Material                                   | Use                                                                    |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| [Consent](consent.md)                      | Read and resolve local contact and deletion dates before participation |
| [Facilitator](facilitator.md)              | Fixed procedure, time limits and neutral prompts                       |
| [Upstream static case](static-upstream.md) | Control condition for Wrong upstream port                              |
| [DNS static case](static-dns.md)           | Control condition for Stale DNS record                                 |
| [Questions](questions.md)                  | Baseline, post-condition and transfer questions                        |
| [Rubric](rubric.md)                        | Manual scoring with separate evidence and recovery dimensions          |
| [Usability](usability.md)                  | SUS response template, scoring and interview                           |
| [Assignments](assignments.csv)             | Four sequences repeated across ten optional slots                      |
| [Result template](result-template.json)    | Private data structure; no filled result belongs in Git                |

Use pseudonyms P01 to P10. Store names, contact details, consent and the mapping from
pseudonym to Cognito/session IDs in a restricted folder outside the repository. Store
study responses and application exports privately. The public report uses anonymous
scores, aggregate summaries and redacted examples only.

## Before the first participant

1. Name the facilitator and deletion owner and give participants their contact address.
2. Confirm the institution's requirements for this student evaluation. Do not claim
   ethics approval from this package.
3. Choose and record a fixed private study-data deletion date before consent. Record
   current application backup expiry separately. The application does not set expiry
   for debrief, history or identity records automatically.
4. Confirm both exact Challenge versions, verified image digests, browser revision and
   deployment settings. Publish only independently reviewed content.
5. Enable Pro for the assigned test learner when DNS is interactive. Use a new session.
6. Freeze the materials and timing. Run one facilitator rehearsal and exclude it from
   participant results. Resolve ambiguous rubric items before collecting responses.

Schedule participants before the release is ready if needed, but do not collect data
until these conditions pass. No automated recruitment or messaging is included.

## Reporting

Report recruited and completed counts, exclusions and their reasons, background,
assignment, incident, hints, completion, raw impact measures, rubric scores and SUS.
Use paired participant descriptions and incident-stratified tables. Do not impute an
interrupted condition as a low learning score. Keep missing results null.

State that the sample is formative, that incident difficulty differs, and that equal
time does not equal identical information exposure. Report concrete usability defects
and changes made afterwards. Claims of broad effectiveness, retention and willingness
to pay require more evidence.
