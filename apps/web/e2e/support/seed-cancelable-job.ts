import { Database } from "bun:sqlite";
import { DEFAULT_GEMINI_MODEL } from "../../../../src/adapters/gemini-model";
import { verifyImmutableJobInput } from "../../../../src/domain/studio-schemas";
import { loadRecipe } from "../../../../src/recipes";
import { LocalSqliteJobRepository } from "../../server-local/studio-jobs/sqlite-job-repository";

interface CancelableJobSeed {
  databasePath: string;
  idempotencyKey: string;
  mediaReceipt: {
    id: string;
    sha256: string;
    retention: { mode: "ephemeral"; expiresAt: string };
  };
}

const input = JSON.parse(await Bun.stdin.text()) as CancelableJobSeed;
const recipe = await loadRecipe("requirements");
const database = new Database(input.databasePath);

try {
  const repository = new LocalSqliteJobRepository(database, {
    createId: () => "job_e2e_cancel_0000001",
  });
  await repository.createOrReplay({
    idempotencyKey: input.idempotencyKey,
    verifiedInput: await verifyImmutableJobInput({
      mediaSessionId: input.mediaReceipt.id,
      mediaSha256: input.mediaReceipt.sha256,
      context: { mode: "none" },
      recipe: {
        id: recipe.recipe.id,
        custom: false,
        revision: recipe.revision,
        sha256: recipe.sha256,
      },
      model: DEFAULT_GEMINI_MODEL,
      retention: input.mediaReceipt.retention,
    }),
    createdAt: new Date().toISOString(),
  });
} finally {
  database.close();
}
