# Skill Agent Instructions

## Contract

- Keep `SKILL.md` below 500 lines.
- Route detailed operating guidance to `docs/RUNBOOK.md`.
- Use `$frame-of-mind` in `agents/openai.yaml` default prompts.
- Trigger on video understanding, Bluedot/Granola meeting analysis, recipes, and multimodal artifacts.
- Never instruct an agent to reveal credentials, signed URLs, or transcript contents.

## Verification

- Run the skill-creator `quick_validate.py` after edits.
- Forward-test setup, normal analysis, missing media, and failed OAuth scenarios.
- Keep detailed credential, recipe, and installation guidance in repository docs.
