# Skill Agent Instructions

## Contract

- Keep `SKILL.md` below 500 lines.
- Keep this directory as the real project skill. Local discovery paths may
  symlink directly here; do not add activation shims or wrapper skills.
- Route detailed operating guidance to `docs/RUNBOOK.md`.
- Use `$frame-of-mind` in `agents/openai.yaml` default prompts.
- Trigger on video understanding, Bluedot/Granola meeting analysis, recipes,
  multimodal artifacts, hosted Studio access/status, `/admin/access`, user
  approval/revocation, Cloudflare deployment, D1 migrations, spend caps, and
  retained R2 media.
- Never instruct an agent to reveal credentials, signed URLs, or transcript contents.
- Keep hosted operating detail in `references/hosted-operations.md` and route
  deployment mutations to the named repository runbook sections.
- Never describe hosted API tokens or agent API access as shipped.
- Keep the portable meeting-to-issue workflow in
  `references/meeting-to-issue.md` synchronized with the full repository
  runbook and ADR 0009.

## Verification

- Run the skill-creator `quick_validate.py` after edits.
- Forward-test setup, normal analysis, missing media, failed OAuth, hosted
  access requests, and maintainer-admin routing scenarios.
- Keep detailed credential, recipe, and installation guidance in repository docs.
