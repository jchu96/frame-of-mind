# Hosted Worker streaming spike — 2026-08-22

## Decision

**GO after Task 2.0b:** the built wrapper-entry and Worker-native digest
workarounds preserve FR-04's browser → Worker → Gemini raw-part contract
without R2 staging. Tasks 2.1–2.4 are unblocked but remain unimplemented.

`apps/web/.output/server/hosted-entry.mjs` imports the stock Nitro artifact and
intercepts only `POST /api/_spike/stream`. The wrapper reuses the existing
Cloudflare Access JWT verifier before reading the body, streams the original
`request.body` into the Content-Range sink, and tees the stream into
Cloudflare's `crypto.DigestStream("SHA-256")`. Every other request delegates to
Nitro unchanged. The route remains absent unless its spike environment flag is
present, and no deployment or production Wrangler configuration changed.

The workerd oracle passed three consecutive runs. In the decisive full run,
all three handlers received `bodyUsed=false`; the independent fixture,
DigestStream, and sink SHA-256 receipts matched; and the two concurrent 8 MiB
requests added 6,930,496 bytes of inspector backing storage. A repeat measured
6,926,400 bytes. Both are well below the prior 33,568,143-byte plateau.

Cloudflare documents `DigestStream` as a writable stream that does not retain
written data, and documents that Workers' WebAssembly instantiation accepts
precompiled modules. The wrapper therefore avoids both original blockers:
[Web Crypto `DigestStream`](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/#digeststream)
and [WebAssembly](https://developers.cloudflare.com/workers/runtime-apis/webassembly/).

The private-R2 amendment is **not needed, not adopted, and kept for reference**
in
[`adr-0018-private-r2-staging-amendment-draft-2026-08-22.md`](adr-0018-private-r2-staging-amendment-draft-2026-08-22.md).

## Task 2.0b oracle

`bun run check:hosted-stream` now:

1. builds the stock `cloudflare_module` artifact and its sibling
   `hosted-entry.mjs` wrapper;
2. scans the emitted wrapper for its route/marker, Nitro fallback import,
   `DigestStream`, and absence of body materialization;
3. proves the authenticated path is 404 while dark and rejects a missing
   Access assertion with 403 when enabled;
4. sends one 16 MiB body and two concurrent 8 MiB bodies through workerd to a
   fake Content-Range sink;
5. checks wrapper, sink, and independent fixture byte/digest receipts; and
6. measures `Runtime.getHeapUsage` backing storage plus host process-tree RSS.

The decisive Task 2.0b receipt is:

```text
HOSTED_STREAM build=PASS cloudflare_module
HOSTED_STREAM hosted_entry_build=PASS apps/web/.output/server/hosted-entry.mjs
HOSTED_STREAM route_source=PASS raw_stream DigestStream no_body_materializer
HOSTED_STREAM artifact_marker=PASS route=true marker=true hosted_entry=true
HOSTED_STREAM dark_gate=PASS authenticated_status=404 env_absent
HOSTED_STREAM access_gate=PASS missing_assertion_status=403
HOSTED_STREAM single_16m_bytes=PASS bytes=16777216 sink_bytes=16777216
HOSTED_STREAM single_16m_digest=PASS sha256=ace873f60c5a925cbf6e49dd456d40e1bb2cdc7689d329f69997e67b139f197b
HOSTED_STREAM concurrent_bytes=PASS uploads=2 bytes_each=8388608 sink_exact=true
HOSTED_STREAM concurrent_digests=PASS a=343314891f2a2b41235120eb6832810cbb543ae9a186bb9bb000ac21822e2857 b=504c55f2b9bec2bb1514dfae56e21990fb2037904b154a06b356ac4ec2ecc39f
HOSTED_STREAM digest_impl=PASS implementation=DigestStream sha256=ace873f60c5a925cbf6e49dd456d40e1bb2cdc7689d329f69997e67b139f197b
HOSTED_STREAM memory_signal=PASS inspector_heap_baseline=9419872 inspector_heap_peak=23514004 inspector_heap_delta=14094132 inspector_backing_baseline=9155422 inspector_backing_peak=10036161 inspector_backing_delta=880739 process_tree_rss_baseline=602456064 process_tree_rss_peak=655196160 process_tree_rss_delta=52740096
HOSTED_STREAM concurrent_backing=PASS inspector_backing_delta=6930496 prior_plateau=33568143 threshold=16784071
HOSTED_STREAM wasm_signal=PASS not_used DigestStream avoids_runtime_wasm_compile
HOSTED_STREAM isolate_total_signal=PASS unavailable workerd_has_no_per_isolate_total_api; process_tree_rss_is_host-level_best_signal
HOSTED_STREAM streaming_path=PASS entry=hosted-entry upstream_body_used=false,false,false stock_nitro_prebuffer=true inspector_backing_delta=6930496
HOSTED_STREAM_SPIKE PASSED
```

The stock Nitro artifact still contains its prebuffering call; the passing
contract is specifically the wrapper's exact-path bypass. This is intentional
and is pinned by both artifact scanning and runtime `bodyUsed` receipts.

## Task 2.0 NO-GO history

The initial **NO-GO** is retained below as causal history. It applied to the
stock Nitro entry before the two Task 2.0b workarounds.

The sink received the right bytes, but only after Nitro had materialized each
request. The stock entry therefore violates the stronger requirement that H3
receive and forward the original stream. A second independent blocker prevents
the requested server-side `hash-wasm` digest: workerd rejects the package's
runtime `WebAssembly.compile()` call.

The then-proposed contract change was private R2 staging, not merely smaller
parts. Smaller parts would reduce the size of each allocation without removing
the materialization boundary. The amendment proposal is
[`adr-0018-private-r2-staging-amendment-draft-2026-08-22.md`](adr-0018-private-r2-staging-amendment-draft-2026-08-22.md).

## Task 2.0 oracle (historical)

`bun run check:hosted-stream` performs the following against the built
`apps/web/.output/server/index.mjs` artifact under Wrangler/workerd:

1. builds the `cloudflare_module` target and runs the Cloudflare boundary scan;
2. serves a synthetic Access JWKS and signs a user assertion;
3. proves the authenticated spike route is 404 when its environment flag is
   absent;
4. enables the route, starts a local fake Content-Range sink, and sends one
   16 MiB body followed by two concurrent 8 MiB bodies;
5. checks route, sink, and independent fixture byte/digest receipts;
6. samples `Runtime.getHeapUsage` through workerd's inspector and the Wrangler
   process-tree RSS; and
7. scans the emitted Nitro entry for the body materialization call.

The route is spike-only at `POST /api/_spike/stream`. It requires a valid
Access assertion and returns 404 unless `NUXT_HOSTED_STREAM_SPIKE_ENABLED` is
set. Its sink is restricted to loopback HTTP. No Gemini endpoint, key, upload,
deployment, production D1, or `wrangler.jsonc` was touched.

## Task 2.0 receipt (historical)

The decisive run used Bun 1.3.14, Wrangler 4.123.0, workerd 1.20260811.1,
Nitro 2.13.4, and `hash-wasm` 4.12.0:

```text
HOSTED_STREAM build=PASS cloudflare_module
HOSTED_STREAM route_source=PASS raw_stream hash_wasm no_readBody_no_readRawBody
HOSTED_STREAM artifact_marker=PASS route=true marker=true
HOSTED_STREAM dark_gate=PASS authenticated_status=404 env_absent
HOSTED_STREAM single_16m_bytes=PASS bytes=16777216 sink_bytes=16777216
HOSTED_STREAM single_16m_digest=PASS sha256=ace873f60c5a925cbf6e49dd456d40e1bb2cdc7689d329f69997e67b139f197b
HOSTED_STREAM concurrent_bytes=PASS uploads=2 bytes_each=8388608 sink_exact=true
HOSTED_STREAM concurrent_digests=PASS a=343314891f2a2b41235120eb6832810cbb543ae9a186bb9bb000ac21822e2857 b=504c55f2b9bec2bb1514dfae56e21990fb2037904b154a06b356ac4ec2ecc39f
HOSTED_STREAM hash_wasm_runtime=FAIL implementation=sink-receipt-fallback failure=runtime_compile_disallowed
HOSTED_STREAM memory_signal=PASS inspector_heap_baseline=6605512 inspector_heap_peak=7410328 inspector_heap_delta=804816 inspector_backing_baseline=762718 inspector_backing_peak=34330861 inspector_backing_delta=33568143 process_tree_rss_baseline=579682304 process_tree_rss_peak=675282944 process_tree_rss_delta=95600640
HOSTED_STREAM wasm_signal=PASS unavailable hash-wasm does_not_expose_linear_memory; inspector_heap_includes_reachable_wasm_wrapper_only
HOSTED_STREAM isolate_total_signal=PASS unavailable workerd_has_no_per_isolate_total_api; process_tree_rss_is_host-level_best_signal
HOSTED_STREAM streaming_path=FAIL nitro_entry=request.arrayBuffer upstream_body_used=true,true,true source=apps/web/.output/server/chunks/nitro/nitro.mjs
HOSTED_STREAM_SPIKE FAILED reason=nitro_cloudflare_module_materializes_request_body,hash_wasm_runtime_compile_disallowed
```

The script intentionally exited 1 for this measured historical NO-GO. After
Task 2.0b it exits 0 only when the wrapper streaming, Access, digest, byte, and
backing-store receipts all pass. It remains a standalone check rather than a
`bun run check` step; its full run is approximately nine seconds on the
measured machine.

## Task 2.0 memory interpretation (historical)

- Inspector JavaScript heap rose by only about 0.8 MB.
- Inspector backing storage rose by 33,568,143 bytes during two concurrent
  8 MiB uploads. That approximately 32 MiB delta is consistent with complete
  request bodies and downstream copies living outside ordinary JS heap.
- Wrangler's complete process tree rose by 95,600,640 bytes. This is a useful
  host-level signal but is not a per-isolate measurement.
- workerd exposes no exact per-isolate total-memory API through the inspector.
  `hash-wasm` exposes no linear-memory handle, and it never instantiated here,
  so a WASM-memory number is unavailable rather than inferred.

The observed peak does not by itself prove a 128 MB isolate OOM. It does prove
the forbidden allocation shape: ordinary heap alone would have hidden the
body copies, while inspector backing storage tracks them.

## Task 2.0 grep proof and exact failure shape (historical)

The route source contains neither H3 body materializer:

```bash
rg -n 'readBody|readRawBody' apps/web/server/api/_spike/stream.post.ts
```

The emitted Nitro entry still contains the upstream materializer before
`localFetch`:

```text
u=Gt.from(await e.arrayBuffer()); ... a.localFetch(... body:u)
```

At runtime all three route receipts reported
`upstreamBodyUsedAtHandler=true`. Before the sink fallback was added solely to
complete byte measurement, `hash-wasm` failed with:

```text
CompileError: WebAssembly.compile(): Wasm code generation disallowed by embedder
```

The successful sink receipts therefore prove transport correctness after
materialization. They do not waive either blocker or authorize Task 2.1.

## Historical re-open criteria

These were the criteria recorded by the original NO-GO. Task 2.0b supplied an
equivalent spec-preserving path—an exact-route wrapper plus `DigestStream`—
without adopting R2:

- a Nitro/workerd combination passes the original-request streaming path and
  a workerd-compatible precompiled SHA-256 module replaces runtime WASM
  compilation; or
- ADR 0018 adopts a private-R2 staging boundary with its own direct-upload,
  ownership, digest, expiry, abort, quota, and cleanup oracle.
