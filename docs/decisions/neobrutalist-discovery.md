# Neobrutalist discovery pages

Status: user-approved visual direction, 31 October 2026.

Apply the approved preview to Home, the Challenge catalogue, and shared navigation.
Use the existing IBM Plex fonts, OpsReplay mark, and Mantine controls. The public
pages use dark outlines, hard shadows, yellow and blue accents, and a pink supporting
surface. The terminal, Code Review editor, scoring, API contracts and account grants
keep their existing implementation.

## Behaviour

- The catalogue renders public server metadata. It does not hardcode a scenario
  library, durations, prices, outcomes, or user entitlements.
- Difficulty, access and category filters retain their existing API parameters.
  Search uses only the currently loaded page and says so in its label.
- Clear filters remains available after a read failure. Empty results and failed
  reads have separate messages. Pagination follows the server cursor.
- Mobile navigation retains all existing routes and authentication actions. Escape
  from the Menu button or a navigation link closes the menu and restores visible
  focus. Route selection closes it.
- Long briefing references have a bounded, keyboard-focusable scroll area so the
  confirmation controls remain visible. Existing start prerequisites, once-only
  request recovery and cooldown checks remain in place.
- Load Mantine's official Popover stylesheet alongside Combobox styles. Select's
  dropdown delegates to Popover; without its CSS, the dropdown lacks positioning.
- The catalogue uses the existing lazy-route pattern with visible loading feedback.
  IBM Plex Sans 700 is self-hosted under the existing family licence.

## Verification and limits

The local UI checks use public schema fixtures and stub identity/API contexts. They
do not contact Cognito, an LLM provider, AWS, or a real Challenge environment. They
verify frontend states and interaction bindings, not hosted authentication or incident
behaviour. No test context or account switch is included in the application.

Verification includes the production build, lint, formatting, type checks, contract
checks, the browser tests that do not require Docker, keyboard and interaction checks,
responsive screenshots, and a serial code review. The Docker-dependent browser
integration test remains a GitHub CI check. Native mobile and a fresh hosted campaign
remain separate.

Local results on 31 October 2026:

- `npm run quality` and `npm run web:build` passed.
- `npm run check` passed: 37 private contract tests and 119 script tests.
- The frontend test run excluding `server-start.integration.test.ts` passed all
  87 tests. That excluded test starts Docker and remains in hosted CI.
- All 26 fixture interaction and keyboard checks passed. Home and the catalogue
  had no page overflow at eight viewport widths from 320 to 1440 CSS pixels.
  Three briefing viewport checks kept start controls visible. Additional checks
  verified the mobile Category width and rejection of malformed public metadata.
- Serial source review found no remaining high-confidence defect. CSS and
  documentation received supplementary manual review.

Screenshots use public fixture data:
[desktop Home](../images/neobrutalist-discovery/home-1440-final.png),
[mobile Home](../images/neobrutalist-discovery/home-390-final.png),
[desktop catalogue](../images/neobrutalist-discovery/catalogue-1440-final.png), and
[mobile catalogue](../images/neobrutalist-discovery/catalogue-390-final.png).

Review follow-up, 31 October 2026: move Escape handling to the header so it also
receives keyboard events from the Menu button. State summary matching in the search
placeholder and use one category-label function for the filter and cards. Remove
44 unused Home rules from the original stylesheet. A CSS parser comparison verified
that all 254 remaining rules were preserved. Local browser checks reproduce the
original Escape failure and verify dismissal from both the toggle and links, focus
restoration, unchanged category values, and summary search without new API reads.

Keep the original production paths and the server-owned access boundary. Reverting
this frontend change restores the previous presentation without migrating data.
