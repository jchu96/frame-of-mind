import { readFile } from "node:fs/promises";
import { ContractError } from "../domain/contract-error.js";

export async function loadCandidatesFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new ContractError("USAGE", "Could not read the candidates document.", {reason:"invalid-candidates"});
  }
}
