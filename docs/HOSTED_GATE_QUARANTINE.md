# Hosted gate quarantine

| Scope | Tracking | Return rule |
|---|---|---|
| Whole `check:lane:hosted` (all eight steps unchanged) | [Hosted lane reliability — issue pending](https://github.com/jchu96/frame-of-mind/issues/PENDING) | ten consecutive local passes on the shared machine and three consecutive nightly passes at an unchanged source revision, without retries |

The issue link is a placeholder for the maintainer to replace before merge.

On 2026-11-13, the reduced lane passed four times, then failed hosted auth
on the fifth run at unchanged base `41766a0`. Two successful runs needed an
internal browser retry. Earlier evidence also reproduced the Better Auth
Workflows failure at unchanged revisions. The default gate must work on the
shared machine where contributors run it; load does not waive a failure.

The complete lane runs nightly and on manual dispatch in `serial-check`,
and must pass inside each `deploy:hosted` invocation before Wrangler runs.
`check:deploy` runs the same gates for release validation without deployment. The six required PR checks
remain in place. No test body, timeout, dependency pin, or retry changed.

The return rule is the expiry condition for this separation. The deploy
wrapper prevents the 2026-11-13 gate move from dropping hosted checks
at deployment. Review demonstrated that writable success receipts could bypass
those checks, so the wrapper now runs them itself; retire that wrapper when an enforced deployment pipeline checks
hosted coverage for the exact source it deploys.
