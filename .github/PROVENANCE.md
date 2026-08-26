# Contribution convention provenance

The contribution guide, pull request template, and issue forms were adapted on
2026-08-27 from `pymc-labs/daimon` at commit `bd31039`.

The upstream document structure and review lessons were retained, while Python,
uv, Postgres, adapter, migration, and pre-commit details were replaced with
Frame of Mind's Bun workspaces, CLI/web/workflows surfaces, repository gates,
and media-safety boundaries. Issue guidance was expanded around Frame of Mind's
evidence-led issue #120 and its separation of observations, causal diagnosis,
proposed changes, and workarounds.

Daimon's Conventional Commits hook informed the policy; this repository uses a
dependency-free Bun validator, a repository-owned `commit-msg` hook, and the
existing CI hygiene gate so contributors do not need Python's pre-commit
framework.
