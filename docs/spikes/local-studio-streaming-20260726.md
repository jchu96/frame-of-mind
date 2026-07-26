# Local Studio Streaming Spike

Date: 2026-07-26

Status: Passed on macOS; cross-platform staging verification remains in Phase 3

## Purpose

Phase 1 had to answer four questions before freezing the Studio media API:

1. Does the shipped Nuxt/Nitro server expose the Bun request body
   incrementally rather than through a full-body helper?
2. Can Bun `FileSink` write bounded chunks, hash the same bytes, and atomically
   seal a temporary file?
3. Can the same runtime serve standards-compliant single byte ranges?
4. Can local-only handlers and `bun:` implementations be absent from the
   Cloudflare review artifact by construction?

The spike uses generated zero bytes only. It contains no recording, transcript,
provider response, meeting identifier, credential, or durable run.

## Exact Environment

| Component | Version |
|---|---|
| Operating system | macOS 26.3, Darwin 25.3.0 arm64 |
| Bun | 1.3.14 |
| Nuxt | 4.5.0 |
| Nitro | 2.13.4 |
| H3 used by Nitro | 1.15.11 |
| Local preset | `node-server`, executed by Bun |
| Hosted preset | `cloudflare-worker` |

Current H3 2 documentation exposes a Web `Request` body. This repository's
Nitro version still resolves H3 1.15.11, where the measured local handler
consumes `event.node.req` as an async iterable. Production work must follow the
installed Nitro contract until the dependency graph moves to H3 2.

## Reproduce

From the repository root:

```bash
bun install --frozen-lockfile
bun run spike:studio-streaming
FRAME_OF_MIND_STUDIO_SPIKE=1 bun run build:web:cloudflare
```

The first command:

- builds the local Nuxt target with two synthetic handlers enabled;
- starts the built server on an ephemeral loopback port;
- streams a generated 32 MiB body in 64 KiB client chunks;
- counts server-side request chunks and samples server heap/RSS;
- hashes while writing through `Bun.file(...).writer()`;
- closes the sink and renames `.partial` to `.sealed`;
- verifies the exact byte count and digest;
- requests `bytes=1024-2047` and an unsatisfiable range;
- removes the temporary directory and stops the process.

The second command builds the Worker with the spike flag deliberately present,
then scans the complete deploy artifact (`server` and `public`) for local
route, path, environment, and `bun:` markers.

## Recorded Result

```json
{
  "bunVersion": "1.3.14",
  "nuxtVersion": "4.5.0",
  "fixtureBytes": 33554432,
  "requestChunks": 65,
  "heapGrowthBytes": 1226175,
  "rssGrowthBytes": 28737536,
  "sha256": "83ee47245398adee79bd9c0a8bc57b821e92aba10f5f9ade8a5d1fae4d8c4302",
  "atomicSeal": true,
  "byteRange": true
}
```

Observed server heap growth was about 1.17 MiB for a 32 MiB request. RSS grew
about 27.4 MiB, which includes Bun, HTTP, native `FileSink`, filesystem cache,
and hashing allocations. The decisive evidence against JavaScript full-body
buffering is the bounded heap result plus 65 request chunks. Phase 3 must repeat
this at larger sizes and under interruption, concurrency, and disk-pressure
faults; this spike is not a 2 GB capacity claim.

Range results:

- `bytes=1024-2047` returned `206`, an exact 1,024-byte body, and
  `Content-Range: bytes 1024-2047/33554432`;
- a range beginning at byte `33554432` returned `416`;
- parser tests cover bounded, open-ended, suffix, clamped, reversed, multiple,
  empty, and unsatisfiable inputs.

Cloudflare result:

```text
Cloudflare boundary clean: 7 forbidden markers absent.
```

## Contract Decisions

The Phase 3 implementation may now freeze these boundaries:

- local upload routes consume the raw H3 1 request stream; they must not call
  `readBody`, `.text()`, `.json()`, or `.arrayBuffer()` for media;
- `Content-Length` is required for the first local multipart contract so disk
  can be reserved and excess input rejected before sealing;
- each received chunk is counted, hashed, and passed to `FileSink`;
- a partial path cannot become usable media until `FileSink.end()` succeeds,
  the exact byte count is verified, and a same-directory atomic rename
  succeeds;
- single byte ranges support bounded, open-ended, and suffix forms; multiple
  ranges are rejected;
- local control-plane handlers live outside Nuxt's scanned `server/` tree and
  are registered only for the exact `node-server` preset;
- retained-media requests carry a server-resolved TTL between one hour and
  seven days; clients cannot supply an arbitrary expiry timestamp;
- the Cloudflare build scans the complete deploy artifact for any `bun:`
  import and local-only marker every time, not only in this spike;
- the repository's `check` and CI path rerun the measured streaming harness so
  a Bun, Nitro, or H3 upgrade cannot silently invalidate this result.

These handlers remain synthetic and disabled unless
`FRAME_OF_MIND_STUDIO_SPIKE=1`. They are not the Phase 3 upload API and do not
accept client paths or real media metadata.

## Operator And Failure Actions

| Failure | Required action before continuing |
|---|---|
| Heap growth exceeds the harness bound | Treat request buffering as unproven; inspect runtime changes |
| Received bytes differ from declared bytes | End the sink, delete partial state, and reject |
| Digest differs | Delete partial or sealed spike state and reject |
| `FileSink.end()` fails | Never rename; preserve the original error category |
| Rename fails | Do not expose the temporary file as sealed |
| Range parser cannot satisfy input | Return `416` with `Content-Range: bytes */<size>` |
| Any forbidden Worker marker appears | Fail the Cloudflare build and fix the import/handler boundary |

## Remaining Uncertainty

- Windows and Linux filesystem, rename, permission, symlink, and disk-reserve
  behavior require Phase 3 verification.
- Process termination between sink close and rename, and between rename and
  receipt persistence, requires startup reconciliation.
- The Phase 3 adapter needs writer ownership, part receipts, retries, expiry,
  free-space reservation, and cleanup-failure persistence.
- A future Nuxt/Nitro upgrade that moves the application to H3 2 must rerun
  this spike and may require using the Web `Request.body` stream instead of
  `event.node.req`.
