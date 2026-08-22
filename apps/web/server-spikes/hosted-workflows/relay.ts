import {
  createError,
  defineEventHandler,
  getRouterParam,
  type H3Event,
} from "h3";

interface WorkflowServiceBinding {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

function getWorkflowService(event: H3Event): WorkflowServiceBinding {
  const env = event.context.cloudflare?.env as
    | { HOSTED_WORKFLOWS?: WorkflowServiceBinding }
    | undefined;
  if (!env?.HOSTED_WORKFLOWS) {
    throw createError({
      statusCode: 503,
      statusMessage: "Hosted Workflow spike service binding is unavailable.",
    });
  }
  return env.HOSTED_WORKFLOWS;
}

async function relay(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw createError({
      statusCode: 502,
      statusMessage: "Hosted Workflow spike service request failed.",
    });
  }
  return await response.json();
}

export default defineEventHandler(async (event) => {
  const service = getWorkflowService(event);
  if (event.method === "POST") {
    return await relay(await service.fetch("http://hosted-workflows.internal/instances", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seed: 7 }),
    }));
  }

  const id = getRouterParam(event, "id") ?? "";
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) {
    throw createError({
      statusCode: 400,
      statusMessage: "Hosted Workflow spike instance ID is invalid.",
    });
  }
  return await relay(await service.fetch(
    `http://hosted-workflows.internal/instances/${encodeURIComponent(id)}`,
  ));
});
