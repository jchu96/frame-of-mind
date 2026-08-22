# Gemini Credentials

This guide explains how to authenticate Frame of Mind without putting a secret
in the repository or chat.

Status as of 2026-08-22: Local Studio resolves Gemini/Granola keys from the
environment or process memory and keeps provider OAuth in exact-resource
private files; these paths are covered by
[`runtime-secrets.test.ts`](../apps/web/test/runtime-secrets.test.ts) and
[`oauth.test.ts`](../test/oauth.test.ts). Hosted creation remains dark and
undeployed. Its Tier A proposal permits `GEMINI_API_KEY` only on the internal
Workflows Worker; Tier B provider-token custody is pending. See
[DATA_CLASSIFICATION.md](DATA_CLASSIFICATION.md) and
[ADR 0018](adr/0018-hosted-studio-trust-boundary.md).

## Short answer

Frame of Mind currently uses the Gemini Developer API Files API. Create an auth
key in Google AI Studio, associate it with a Google Cloud project, and expose it
locally as `GEMINI_API_KEY`.

Google Workspace does not create Gemini API keys. A Workspace identity may be
the Google account you sign in with, but projects, billing, IAM, and API keys
belong to Google Cloud and Google AI Studio.

## Supported authentication matrix

| Path | Current support | Best for |
|---|---|---|
| Google AI Studio auth key | Supported | local CLI and colleague setup |
| Imported Google Cloud project + AI Studio auth key | Supported | organization-owned billing/project |
| Standard restricted Gemini API key | Transitional | existing setups only |
| Vertex AI + Application Default Credentials | Not yet supported by the video upload pipeline | future enterprise backend |
| Service account JSON key | Not supported or recommended for the current local flow | avoid on personal workstations |

## Why the current path uses an API key

The CLI uploads videos through Google's documented resumable Files protocol:

```ts
POST /upload/v1beta/files
X-Goog-Api-Key: <local key>
X-Goog-Upload-Protocol: resumable
```

The upload is streamed to the exact signed Gemini URL returned by the start
request. `@google/genai` handles file status, generation, and deletion. The
Gemini Developer Files service is not available on a Vertex AI client. Vertex
therefore needs a different media path, such as a Google Cloud Storage object
plus Vertex multimodal input. That backend is architectural future work, not an
environment variable switch.

## Option A: New user in Google AI Studio

1. Open the [Google AI Studio API Keys page](https://aistudio.google.com/apikey).
2. Sign in with the Google account that should own or access the project.
3. Accept the applicable terms.
4. If AI Studio creates a default project/key, review the project name and
   billing ownership.
5. Otherwise select **Create API key**.
6. Choose or create the intended project.
7. Copy the key once and move it directly into your local secret workflow.
8. Do not paste it into an issue, chat, shell history, screenshot, or committed
   dotenv file.

As of July 2026, Google says new AI Studio keys are authorization keys bound to
a service account. Prefer these over older standard keys.

## Option B: Use an existing Google Cloud project

Use this when a company or team already has a Cloud project and billing policy.

### Required project access

The person creating the key needs permissions that cover:

- reading the project;
- creating API keys;
- enabling the required service when authorized;
- creating the linked service account;
- binding the service account to the API key.

Google lists roles such as Project Editor as containing these capabilities, but
an administrator may prefer narrower custom roles. Frame of Mind does not modify
IAM or enable APIs on your behalf.

### Import the project into AI Studio

1. Open Google AI Studio.
2. Open **Dashboard**.
3. Select **Projects**.
4. Choose **Import projects**.
5. Search for the exact Cloud project.
6. Import it.
7. Open **API Keys**.
8. Create a new key in that imported project.
9. Confirm the project and billing owner before using the key.

If **Create API key** is disabled, ask the project administrator for the
required access. Do not work around organization policy with a shared key.

## Billing and quota

Video analysis can consume meaningful tokens and file-processing quota.

For paid Gemini Developer API usage:

1. open AI Studio **Projects** or **API Keys**;
2. choose **Set up billing**;
3. link or create the approved Cloud Billing account;
4. complete any required prepaid-credit setup;
5. configure billing alerts in Google Cloud;
6. review usage under AI Studio **Dashboard → Usage**.

A valid key can still return HTTP 429 when:

- free-tier quota is exhausted;
- prepaid credits are depleted;
- project rate limits are exceeded;
- the selected model has no remaining allocation.

Retrying does not fix depleted billing. Correct the project/quota state first.

## Configure the local shell

### Private local `.env`

Frame of Mind quietly loads `.env` from the current working directory:

```bash
cp .env.example .env
```

Populate `GEMINI_API_KEY` locally. `.env` is ignored by git, but that is not
encryption. Use a secret manager for stronger controls and never share the file.

The local Studio uses the same file:

```bash
bun run studio
```

Studio opens a one-time URL on an inert launch page, exchanges the fragment,
and then visits **Connections**. Every data-bearing Studio page/API requires
the resulting HttpOnly session. An environment value always takes precedence
over a temporary value entered in the page. To replace an environment value,
edit `.env`, stop Bun, and launch Studio again.

If automatic browser opening fails, stop Studio and rerun with
`FRAME_OF_MIND_STUDIO_PRINT_URL=1`. This explicitly prints the sensitive
one-time bearer URL; keep it out of shared terminals, recordings, issues, and
logs.

### Temporary Studio input

The Connections page can accept Gemini or Granola keys for the current launch.
These values:

- exist only in Bun process memory;
- disappear when Bun stops;
- are never returned by the status API;
- are not written to `.env`, SQLite, logs, or a settings file.

Use this for a quick test, not as durable secret storage. The page intentionally
does not edit `.env` on your behalf because an ignored plaintext file is not a
credential vault.

### Provider OAuth files

`frameofmind auth bluedot`, `frameofmind auth granola`, and the matching Studio
buttons use the existing private OAuth token files. Those tokens survive a Bun
restart and remain bound to the exact configured MCP resource URL. A custom
endpoint cannot inherit the canonical provider credential.

When Studio already shows OAuth as configured, **Verify OAuth** checks the
stored credential; it does not switch accounts. To change accounts, close the
CLI/Studio, remove only that provider's token file using the runbook, and
connect again.

### macOS or Linux: current terminal only

```bash
export GEMINI_API_KEY="your-key"
frameofmind doctor
```

This disappears when the terminal closes.

### macOS with zsh: persistent user environment

Add the export to a private shell configuration or, preferably, load it through
your password manager:

```bash
export GEMINI_API_KEY="your-key"
```

Then open a new terminal or reload the intended shell configuration.

Do not commit a shell config or `.env` containing the value to a public repo.

### Linux with bash

Use the same export syntax in the current shell or a protected user profile:

```bash
export GEMINI_API_KEY="your-key"
```

### Windows PowerShell: current terminal only

```powershell
$env:GEMINI_API_KEY = "your-key"
frameofmind doctor
```

### Windows: persistent user variable

Use **System Properties → Environment Variables → User variables**, create
`GEMINI_API_KEY`, and open a new terminal.

Avoid system-wide variables on shared machines.

## Password manager examples

The exact command depends on your approved tool. The pattern is:

```bash
GEMINI_API_KEY="<value injected by secret manager>" frameofmind doctor
```

The secret should exist only in the child process environment. Do not echo it.

## Verify without exposing the key

```bash
frameofmind doctor
```

Expected:

```text
ok Node >=22
ok GEMINI_API_KEY
```

`doctor` checks presence, not value, billing, restrictions, or quota. A bounded
authorized analysis is the end-to-end verification.

Never run:

```bash
echo "$GEMINI_API_KEY"
```

Do not include the environment in diagnostic bundles.

## Key restrictions and the 2026 transition

Google is transitioning the Gemini Developer API from standard keys to
authorization keys.

Current operational guidance:

- create new keys through AI Studio;
- prefer auth keys;
- do not use unrestricted standard keys;
- if an existing standard key must remain temporarily, restrict it to the
  Gemini/Generative Language API as Google documents;
- plan to replace standard keys before Google's September 2026 cutoff;
- use one key/project per trust boundary instead of sharing one key broadly.

When restrictions are edited in Cloud Console, verify they remain compatible
with Gemini Developer API. A generic key shared across unrelated Google APIs is
not recommended.

## Rotation

1. Create a replacement auth key in the same approved project.
2. Update the local secret manager or environment.
3. Run `frameofmind doctor`.
4. Run a bounded authorized test.
5. Confirm success and usage attribution.
6. Disable or delete the old key through the provider console.
7. Review usage for unexpected calls.

Do not delete the old key before the replacement is verified if doing so would
interrupt an approved workflow.

## Suspected leak

1. Stop using the key.
2. Create a replacement in AI Studio.
3. update local and deployment secrets;
4. verify the replacement;
5. disable/delete the leaked key;
6. inspect AI Studio usage and Cloud billing;
7. rotate any copied secrets in CI or password managers;
8. remove the key from git history if it was committed;
9. treat public git exposure as compromise even if quickly reverted.

## Google Cloud and Vertex AI path

Vertex AI is reasonable for organizations that require:

- IAM identities instead of personal API keys;
- centralized Cloud billing and audit;
- service account impersonation;
- Cloud Storage controls;
- regional/resource policies.

Typical local authentication is:

```bash
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT="your-project-id"
export GOOGLE_CLOUD_LOCATION="global"
export GOOGLE_GENAI_USE_VERTEXAI="true"
```

However, the current Frame of Mind pipeline will not use those variables. A
future Vertex backend must:

1. initialize `GoogleGenAI` with `vertexai: true`, project, and location;
2. stage large videos in a private Cloud Storage bucket;
3. grant only the required object/model access;
4. record bucket/object provenance without leaking signed URLs;
5. delete staged objects on success and failure;
6. handle Vertex model names and regions;
7. add IAM, quota, retention, and incident-response docs.

Until that backend exists, use an AI Studio auth key even when its project and
billing are organization-owned.

## Official references

- [Using Gemini API keys](https://ai.google.dev/gemini-api/docs/api-key)
- [Gemini API getting started](https://ai.google.dev/gemini-api/docs/get-started)
- [Gemini Files API](https://ai.google.dev/gemini-api/docs/files)
- [Vertex AI Gemini quickstart](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/quickstart)
- [Google Cloud authentication](https://docs.cloud.google.com/docs/authentication)
- [Set up local Application Default Credentials](https://docs.cloud.google.com/docs/authentication/set-up-adc-local-dev-environment)
