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

Every source process call passes this environment explicitly. Child captures
exercise the real call sites; a source guard inventories permitted process APIs
and refuses new unreviewed sites. A secret-name deny-list is insufficient because
an innocuously named variable can hold a credential.

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
