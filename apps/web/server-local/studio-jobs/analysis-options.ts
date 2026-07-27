import { homedir, platform } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
  ContextFileReceipt,
  RuntimeSecretResolver,
} from "../../../../src/domain/studio-ports.js";
import type {
  AnalysisJob,
  ImmutableJobInput,
} from "../../../../src/domain/studio-schemas.js";
import {
  loadRecipe,
} from "../../../../src/recipes/index.js";
import type {
  AnalyzeOptions,
} from "../../../../src/services/analyze.js";

const DEFAULT_MAX_INCIDENTS = 10;

interface LocalMediaPathResolver {
  resolveInUsePath(
    mediaSessionId: string,
    expectedSha256: string,
  ): Promise<string>;
}

interface LocalContextFileLease {
  path: string;
  receipt: ContextFileReceipt;
  release(): Promise<void>;
}

interface LocalContextFileResolver {
  get(id: string): Promise<ContextFileReceipt | undefined>;
  acquire(id: string): Promise<LocalContextFileLease>;
}

type OAuthCredentialReader = (
  provider: "bluedot" | "granola",
) => boolean;

export interface LocalStudioAnalyzeOptionsResolverOptions {
  media: LocalMediaPathResolver;
  contextFiles?: LocalContextFileResolver;
  secrets: RuntimeSecretResolver;
  oauthCredentialPresent: OAuthCredentialReader;
  outputRoot?: string;
  screenshots?: boolean;
  maxIncidents?: number;
}

export class StudioJobInputUnavailableError extends Error {
  constructor(readonly code: string) {
    super("Local Studio analysis input is unavailable.");
    this.name = "StudioJobInputUnavailableError";
  }
}

/**
 * Resolves private, process-local capabilities from immutable job receipts.
 * Returned options are consumed only by the local executor and never persisted.
 */
export class LocalStudioAnalyzeOptionsResolver {
  readonly #outputRoot: string;
  readonly #screenshots: boolean;
  readonly #maxIncidents: number;
  readonly #contextLeases = new Map<string, LocalContextFileLease>();

  constructor(
    private readonly options: LocalStudioAnalyzeOptionsResolverOptions,
  ) {
    this.#outputRoot = resolve(
      options.outputRoot ?? resolveLocalRunRoot(),
    );
    this.#screenshots = options.screenshots ?? true;
    this.#maxIncidents = options.maxIncidents ?? DEFAULT_MAX_INCIDENTS;
    if (
      !Number.isSafeInteger(this.#maxIncidents)
      || this.#maxIncidents < 1
      || this.#maxIncidents > 1_000
    ) {
      throw new StudioJobInputUnavailableError("invalid_runtime_bounds");
    }
  }

  async assertReady(input: ImmutableJobInput): Promise<void> {
    await this.#resolveRecipe(input);
    await this.#requireSecret("gemini-api-key", "gemini_not_configured");
    if (input.context.provider === "file") {
      if (!this.options.contextFiles) {
        throw new StudioJobInputUnavailableError(
          "context_file_staging_unavailable",
        );
      }
      const receipt = await this.options.contextFiles.get(
        input.context.contextFileId,
      );
      if (!receipt) {
        throw new StudioJobInputUnavailableError("context_file_not_found");
      }
      if (receipt.sha256 !== input.context.contextFileSha256) {
        throw new StudioJobInputUnavailableError(
          "context_file_receipt_mismatch",
        );
      }
      return;
    }
    if (
      input.context.provider === "granola"
      && input.context.transport === "api"
    ) {
      await this.#requireSecret(
        "granola-api-key",
        "granola_api_not_configured",
      );
      return;
    }
    if (!this.options.oauthCredentialPresent(input.context.provider)) {
      throw new StudioJobInputUnavailableError(
        `${input.context.provider}_oauth_not_configured`,
      );
    }
  }

  async resolve(job: AnalysisJob): Promise<AnalyzeOptions> {
    await this.assertReady(job.input);
    const recipe = await this.#resolveRecipe(job.input);
    const apiKey = await this.#requireSecret(
      "gemini-api-key",
      "gemini_not_configured",
    );
    const context = job.input.context;
    const granolaApiKey = context.provider === "granola"
        && context.transport === "api"
      ? await this.#requireSecret(
        "granola-api-key",
        "granola_api_not_configured",
      )
      : undefined;
    const video = await this.options.media.resolveInUsePath(
      job.input.mediaSessionId,
      job.input.mediaSha256,
    );
    const contextLease = context.provider === "file"
      ? await this.options.contextFiles!.acquire(context.contextFileId)
      : undefined;
    if (
      context.provider === "file"
      && contextLease
      && contextLease.receipt.sha256 !== context.contextFileSha256
    ) {
      await contextLease.release().catch(() => undefined);
      throw new StudioJobInputUnavailableError(
        "context_file_receipt_mismatch",
      );
    }
    if (contextLease) this.#contextLeases.set(job.id, contextLease);
    return {
      meetingId: context.provider === "file"
        ? context.contextFileId
        : context.meetingId,
      recipe: recipe.recipe,
      customRecipe: recipe.custom,
      recipeSha256: recipe.sha256,
      recipeRevision: recipe.revision,
      contextProvider: context.provider,
      granolaTransport: context.provider === "granola"
        ? context.transport
        : "mcp",
      ...(granolaApiKey ? { granolaApiKey } : {}),
      interactiveProviderAuth: false,
      apiKey,
      model: job.input.model,
      video,
      expectedVideoSha256: job.input.mediaSha256,
      ...(contextLease ? { contextFile: contextLease.path } : {}),
      ...(job.input.focus ? { focus: job.input.focus } : {}),
      outputRoot: this.#outputRoot,
      maxIncidents: this.#maxIncidents,
      screenshots: this.#screenshots,
      keepUpload: false,
    };
  }

  async releaseContextFile(jobId: string): Promise<void> {
    const lease = this.#contextLeases.get(jobId);
    if (!lease) return;
    this.#contextLeases.delete(jobId);
    await lease.release();
  }

  async #resolveRecipe(input: ImmutableJobInput) {
    if (input.recipe.custom) {
      throw new StudioJobInputUnavailableError(
        "custom_recipe_staging_unavailable",
      );
    }
    let recipe;
    try {
      recipe = await loadRecipe(input.recipe.id);
    } catch {
      throw new StudioJobInputUnavailableError("recipe_not_found");
    }
    if (
      recipe.custom
      || recipe.sha256 !== input.recipe.sha256
      || recipe.revision !== input.recipe.revision
    ) {
      throw new StudioJobInputUnavailableError("recipe_receipt_mismatch");
    }
    return recipe;
  }

  async #requireSecret(
    name: "gemini-api-key" | "granola-api-key",
    code: string,
  ): Promise<string> {
    const value = await this.options.secrets.resolve(name);
    if (!value) throw new StudioJobInputUnavailableError(code);
    return value;
  }
}

export function resolveLocalRunRoot(
  environment: NodeJS.ProcessEnv = process.env,
  operatingSystem = platform(),
): string {
  const override = environment.FRAME_OF_MIND_OUTPUT?.trim();
  if (override) {
    if (!isAbsolute(override)) {
      throw new StudioJobInputUnavailableError("unsafe_output_root");
    }
    return resolve(override);
  }
  if (operatingSystem === "win32") {
    return join(
      environment.LOCALAPPDATA
        || join(homedir(), "AppData", "Local"),
      "Frame of Mind",
      "runs",
    );
  }
  if (operatingSystem === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "frame-of-mind",
      "runs",
    );
  }
  return join(
    environment.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "frame-of-mind",
    "runs",
  );
}
