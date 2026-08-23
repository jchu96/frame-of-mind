# Hosted Studio UX Copy

Use these sentences verbatim on the hosted first-time-user path where the
corresponding state appears. They are the plain-language contract for this UX
pass.

## Copy Deck

1. Intent: “What should we look for in this recording? Pick one.”
2. Results: “Your finished analyses, in one place. Only you can see them.”
3. Recording unavailable: “Uploading a recording here isn't available yet. For now, run this analysis from the desktop Studio.”
4. Before starting: “Your recording will be sent to Google Gemini for analysis and deleted from Gemini when it finishes. The settings below are saved with the results so you can see exactly how they were produced.”
5. Activity: “Analyses you've started, and how they're going.”
6. Account footer: “{email} · Sign out”
7. Missing intent: “Choose what to look for first.”
8. Missing context: “Confirm which sources to use.”
9. Missing recording: “Add a recording first.”
10. Timeline: omit the generic transition sentence and show the human stage name with its time.

## Plain-language glossary

| Internal term | User-facing language |
|---|---|
| principal | you; your account |
| receipt | saved record, or omit it |
| sealed | uploaded and locked |
| recipe or intent | what to look for; goal |
| context | extra sources, such as a transcript or notes |
| retained | kept until `{date}` |
| ephemeral | deleted after analysis |
| projection or bundle | results, or omit it |
| provenance | how it was produced |
| immutable or idempotency | never user-facing |
| stage or staging | upload, or the specific human stage name |
| attempt | try; show only after the first try |

User-facing hosted copy should explain the action or consequence. Internal
contract names remain appropriate in code, tests, operator documentation, and
support details, but not as instructions to a first-time user.
