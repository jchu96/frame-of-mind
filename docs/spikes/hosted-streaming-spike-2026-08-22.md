# Hosted Worker streaming spike — 2026-08-22

## Decision

**GO at 4 MiB parts with a per-principal concurrency cap of 4, pending an ADR
0018 amendment.** Task 2.0d accepts the measured runtime materialization and
bounds it by construction instead of claiming ideal streaming. Tasks 2.1–2.4
must not implement the new numbers until the amendment is reviewed and
adopted. Private R2 remains the second fallback, not the active design.

`apps/web/.output/server/hosted-entry.mjs` imports the stock Nitro artifact and
intercepts only the normalized `POST /api/_spike/stream` path. The wrapper
reuses the existing Cloudflare Access JWT verifier before reading the body and
uses one `TransformStream`: each chunk is counted, written to Cloudflare's
`crypto.DigestStream("SHA-256")`, and enqueued unchanged to the sink. The old
Nitro spike route was deleted, so trailing, repeated-slash, and percent-encoded
variants cannot fall through to a prebuffering handler. Every other request
delegates to Nitro unchanged. The route remains absent unless its spike
environment flag is present, and no deployment or production Wrangler
configuration changed.

Task 2.0c remains the causal proof that raw 8 MiB parts are not bounded under
backpressure: one slow request added 8,398,085 bytes of inspector backing
storage. Task 2.0d measures 1, 2, and 4 MiB parts at concurrency 2 and 4 in a
fresh Wrangler process per combination. A combination passes only when its
hold delta is no more than `part × concurrency × 1.5` and its full-run backing
peak growth is no more than 24 MiB. All six combinations pass.

Cloudflare documents `DigestStream` as a writable stream that does not retain
written data, and documents that Workers' WebAssembly instantiation accepts
precompiled modules. The wrapper therefore avoids both original blockers:
[Web Crypto `DigestStream`](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/#digeststream)
and [WebAssembly](https://developers.cloudflare.com/workers/runtime-apis/webassembly/).

The private-R2 amendment is **the second fallback, not adopted, and grants no
implementation authority** in
[`adr-0018-private-r2-staging-amendment-draft-2026-08-22.md`](adr-0018-private-r2-staging-amendment-draft-2026-08-22.md).

## FR-04 amendment proposal: 4 MiB parts, concurrency 4

This section proposes an ADR 0018 amendment; it does not edit or adopt ADR
0018. Replace FR-04's raw 8 MiB part with:

- at most **4 MiB** per non-final raw part;
- at most **4 concurrent in-flight parts per validated principal**;
- Gemini's accepted offset remains resume authority;
- a completed receipt covers exactly the bytes forwarded and is written only
  after `DigestStream.bytesWritten` equals the declared part size;
- a runtime-truncated request is legitimate when its forwarded bytes equal the
  declaration, while an early-close/short part is rejected with no receipt;
  and
- full-file browser SHA-256 and final Gemini digest comparison remain
  unchanged.

Rationale: workerd may materialize an inbound request while the provider sink
is backpressured. The new size and concurrency numbers bound that accepted
behavior by construction. The 4 MiB × 4 case allows a 25,165,824-byte
materialization-tolerant threshold, while the independent absolute backing
growth cap remains 25,165,824 bytes (24 MiB). Its measured hold and full-run
peak growth were both 2,842,764 bytes.

### Task 2.0d oracle

Each matrix combination starts a fresh Wrangler process and inspector so a
warmed isolate cannot reuse prior backing allocations and create a false-low
delta. The sink delays every first read by at least 2,500 ms, all clients send
as fast as pull permits, and every completed digest matches its independent
fixture.

```text
HOSTED_STREAM part_bound part=1048576 concurrency=2 hold_delta=2107920 peak=2107920 rss_peak=591151104 bounded=true
HOSTED_STREAM part_bound part=1048576 concurrency=4 hold_delta=606348 peak=606348 rss_peak=602210304 bounded=true
HOSTED_STREAM part_bound part=2097152 concurrency=2 hold_delta=536646 peak=536646 rss_peak=589545472 bounded=true
HOSTED_STREAM part_bound part=2097152 concurrency=4 hold_delta=4780172 peak=4780172 rss_peak=602128384 bounded=true
HOSTED_STREAM part_bound part=4194304 concurrency=2 hold_delta=4687100 peak=4687100 rss_peak=604815360 bounded=true
HOSTED_STREAM part_bound part=4194304 concurrency=4 hold_delta=2842764 peak=2842764 rss_peak=628490240 bounded=true
HOSTED_STREAM slow_sink=PASS combos=6 delay_ms_min=2500 all_digests_exact=true
HOSTED_STREAM over_length_truncation=PASS declared_bytes=8388608 source_bytes=9437184 forwarded_bytes=8388608 status=200 receipt=true
HOSTED_STREAM short_part=PASS declared_bytes=8388608 forwarded_bytes=none status=502 sink_aborted=false sink_not_reached=true receipt=false
HOSTED_STREAM client_abort=PASS client=AbortError sink_bytes=131072 sink_aborted=true receipt=false
HOSTED_STREAM decision=PASS GO part=4194304 concurrency_cap=4 pending_ADR_amendment
HOSTED_STREAM_SPIKE PASSED
```

`rss_peak` is the measured Wrangler process-tree peak, not per-isolate memory
and not part of the backing-store verdict. In the short-part check, workerd
rejected the 7 MiB source before the sink was reached; no partial sink receipt
existed. The wrapper also compares `DigestStream.bytesWritten` with the
declared part size before reading or returning a sink receipt.

## Task 2.0c oracle (superseded 8 MiB contract)

`bun run check:hosted-stream` now additionally:

1. proves the stock Nitro upload handler and its marker are absent;
2. verifies normalized trailing-slash, repeated-slash, and percent-encoded
   variants are handled by the wrapper rather than Nitro;
3. exercises missing, wrong-audience, wrong-issuer, expired, `alg: none`,
   empty-subject, and service-principal Access assertions;
4. stalls the sink's first read for at least 2,500 ms and requires inspector
   backing growth below 2 MiB while the client sends 8 MiB as pull permits;
5. sends a source that declares 8 MiB and produces 9 MiB, requiring rejection,
   sink abort, no receipt, and bounded memory; and
6. aborts a client after partial sink progress and requires sink abort with no
   digest receipt.

The decisive Task 2.0c receipt is:

```text
HOSTED_STREAM route_source=PASS single_transform DigestStream byte_cap no_tee no_body_materializer
HOSTED_STREAM artifact_marker=PASS hosted_entry=true nitro_route_absent=true
HOSTED_STREAM dark_gate=PASS authenticated_status=404 env_absent
HOSTED_STREAM access_negatives=PASS missing=403 wrong_aud=403 wrong_iss=403 expired=403 alg_none=403 empty_sub=403 service=403
HOSTED_STREAM bypass_variants=PASS trailing=wrapper double_slash=wrapper percent_decoded=wrapper nitro_handler=absent
HOSTED_STREAM slow_sink=FAIL delay_ms=2503 inspector_backing_baseline=2782145 inspector_backing_hold=11180230 inspector_backing_hold_delta=8398085 limit=2097152 bytes=8388608 sha256=d733520471bb97a1d7af3119d85ee9c1438068a1cfeaf83b12f5e8d0c9846a59
HOSTED_STREAM over_length=FAIL declared_bytes=8388608 sent_bytes=9437184 status=200 sink_bytes=8388608 sink_aborted=false receipt=true inspector_backing_delta=3092515 limit=2097152
HOSTED_STREAM client_abort=PASS client=AbortError sink_bytes=131072 sink_aborted=true receipt=false
HOSTED_STREAM single_16m_bytes=PASS bytes=16777216 sink_bytes=16777216
HOSTED_STREAM concurrent_bytes=PASS uploads=2 bytes_each=8388608 sink_exact=true
HOSTED_STREAM streaming_path=PASS entry=hosted-entry upstream_body_used=false,false,false,false,false,false,false stock_nitro_prebuffer=true inspector_backing_delta=8399338
HOSTED_STREAM_SPIKE FAILED reason=slow_sink_unbounded,over_length_contract_failed
```

The nonzero exit is intentional: all required checks execute, and the command
passes only if both blockers clear. The separate hosted Access contract passes
against both the stock and wrapper entries.

## Task 2.0b oracle (superseded fast-sink result)

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

The stock Nitro artifact still contains its general prebuffering call. Task
2.0c deleted the old upload route and made the wrapper the only spike handler,
but its slow-sink result supersedes this provisional pass.

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

The script intentionally exited 1 for this measured historical NO-GO. It
remains a standalone check rather than a
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

These were the criteria recorded by the original NO-GO. Task 2.0b appeared to
supply an equivalent exact-route wrapper plus `DigestStream`, but Task 2.0c's
slow-sink oracle disproved its bounded-memory assumption:

- a Nitro/workerd combination passes the original-request streaming path and
  a workerd-compatible precompiled SHA-256 module replaces runtime WASM
  compilation; or
- ADR 0018 adopts a private-R2 staging boundary with its own direct-upload,
  ownership, digest, expiry, abort, quota, and cleanup oracle.
