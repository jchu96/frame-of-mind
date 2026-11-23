# ADR 0026: Child processes receive an explicit environment

- Date: 2026-11-13
- Status: Accepted

## Invariant

Secrets intended for in-process provider calls must not be inherited by media
tools or browser openers.

## Context

A synthetic marker probe showed that media subprocesses inherited the tool's
whole environment, including variables intended only for in-process provider
calls. Six process starts across five source files had implicit inheritance.

## Decision

Build a new environment from named executable/library paths, locale categories,
temporary directories and home variables. Browser openers additionally receive
named desktop-session variables. Windows matching is case-insensitive and
preserves spelling. The complete lists are in RUNBOOK §6.20.

Every shipped source process call passes this environment explicitly. The helper
is also the shared import point for process APIs; callers still supply `env`.
A simple convention check flags plain process-module access outside that helper
and direct Bun access. It does not detect computed or indirect access; the real
protection is the explicit helper environment at every shipped call, verified by
the per-site marker tests running the children. A secret-name deny-list is
insufficient because an innocuously named variable can hold a credential.

## Consequences

Provider credentials stay in the parent environment. Operators needing another
runtime variable report its name and purpose for review without disclosing its
value. Allowed values remain operator-controlled; this is environment isolation,
not a sandbox for executable paths or the user's desktop. Arguments, timeouts,
retry policy, media retention and hosted behavior are unchanged.

## Alternatives considered

A deny-list misses credentials with unexpected names. Whole-environment
inheritance preserves the observed disclosure. A single process wrapper would
move the current API boundary; explicit environment options keep this fix local.
