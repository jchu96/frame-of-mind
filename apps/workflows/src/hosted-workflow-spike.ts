import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

interface SpikeParameters {
  seed: number;
}

interface SpikeOutput {
  first: number;
  second: string;
}

interface Env {
  HOSTED_WORKFLOW: Workflow<SpikeParameters>;
}

const STEP_CONFIG = {
  retries: {
    limit: 0,
    delay: "1 second",
    backoff: "constant",
  },
  timeout: "1 minute",
} as const;

export class HostedWorkflowSpike extends WorkflowEntrypoint<Env, SpikeParameters> {
  override async run(
    event: Readonly<WorkflowEvent<SpikeParameters>>,
    step: WorkflowStep,
  ): Promise<SpikeOutput> {
    const first = await step.do("derive synthetic value", STEP_CONFIG, async () => {
      return event.payload.seed * 2;
    });
    const second = await step.do("format synthetic value", STEP_CONFIG, async () => {
      return `workflow-${first}`;
    });
    return { first, second };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "frame-of-mind-hosted-workflows-spike" });
    }

    if (request.method === "POST" && url.pathname === "/instances") {
      const body = await request.json().catch(() => undefined) as
        | Partial<SpikeParameters>
        | undefined;
      if (!Number.isSafeInteger(body?.seed) || Number(body?.seed) < 1) {
        return Response.json({ error: "invalid_seed" }, { status: 400 });
      }
      const instance = await env.HOSTED_WORKFLOW.create({
        params: { seed: Number(body?.seed) },
      });
      return Response.json({ instanceId: instance.id }, { status: 201 });
    }

    const match = request.method === "GET"
      ? /^\/instances\/([a-zA-Z0-9_-]{1,100})$/.exec(url.pathname)
      : null;
    if (match?.[1]) {
      const instance = await env.HOSTED_WORKFLOW.get(match[1]);
      return Response.json(await instance.status());
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
