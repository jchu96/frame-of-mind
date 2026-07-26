import type {
  RuntimeSecretName,
  RuntimeSecretPresence,
  RuntimeSecretResolver,
} from "../../../../src/domain/studio-ports.js";

const environmentName: Record<RuntimeSecretName, string> = {
  "gemini-api-key": "GEMINI_API_KEY",
  "granola-api-key": "GRANOLA_API_KEY",
};
const minimumSecretLength = 8;
const maximumSecretLength = 8_192;
let configuredResolver: ProcessRuntimeSecretResolver | undefined;

function validSecret(value: string): boolean {
  return value.trim().length >= minimumSecretLength
    && value.length <= maximumSecretLength
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export class ProcessRuntimeSecretResolver implements RuntimeSecretResolver {
  readonly #environment: Record<string, string | undefined>;
  readonly #session = new Map<RuntimeSecretName, string>();

  constructor(environment: Record<string, string | undefined>) {
    this.#environment = environment;
  }

  async resolve(name: RuntimeSecretName): Promise<string | undefined> {
    const environmentValue = this.#environment[environmentName[name]];
    if (environmentValue) return environmentValue;
    return this.#session.get(name);
  }

  async status(name: RuntimeSecretName): Promise<RuntimeSecretPresence> {
    if (this.#environment[environmentName[name]]) {
      return { name, present: true, source: "environment" };
    }
    if (this.#session.has(name)) {
      return { name, present: true, source: "session" };
    }
    return { name, present: false, source: "none" };
  }

  async setSession(name: RuntimeSecretName, value: string): Promise<void> {
    if (!validSecret(value)) {
      throw new Error("Runtime secret input is invalid.");
    }
    this.#session.set(name, value);
  }

  async clearSession(name: RuntimeSecretName): Promise<void> {
    this.#session.delete(name);
  }

  redact(value: string): string {
    let redacted = value;
    const knownValues = [
      ...Object.values(environmentName)
        .map((name) => this.#environment[name]),
      ...this.#session.values(),
    ]
      .filter((secret): secret is string => Boolean(secret))
      .filter((secret, index, values) => values.indexOf(secret) === index)
      .sort((left, right) => right.length - left.length);
    for (const secret of knownValues) {
      redacted = redacted.replaceAll(secret, "[REDACTED]");
    }
    return redacted;
  }
}

export function getRuntimeSecretResolver(): ProcessRuntimeSecretResolver {
  configuredResolver ??= new ProcessRuntimeSecretResolver(process.env);
  return configuredResolver;
}
