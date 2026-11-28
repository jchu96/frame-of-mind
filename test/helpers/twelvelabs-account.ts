// In-memory account. Ownership is a client receipt property. This service will
// delete another run's asset in the same account and will accept another POST.
export class TwelveLabsAccount {
  readonly assets = new Set(["ffffffffffffffffffffffff"]);
  readonly assetOperations = new Map<string,string|undefined>();
  readonly tasks = new Map<string, Record<string, unknown>>();
  readonly requests: {method:string; path:string; body:string; operation?:string}[] = [];
  readonly creates: string[] = [];
  lost = false;
  denyDeletion = false;
  entityLinked = false;
  wrongOwner = false;
  readonly tasksCreated: {analysis_mode:string;response_format:{segment_definitions:{fields:unknown[]}[]};prompt?:string;prompt_v2?:{input_text:string}}[] = [];
  unreadableLinks = false;
  linked = false;
  partial = false;
  empty = false;
  queued = false;
  quotaAfter = Infinity;
  grades = 0;
  onRequest = () => {};
  segments = [{start_time:1,end_time:5,metadata:{reason:"CLAIM_FIXTURE",label:"LABEL_FIXTURE",surface:"SURFACE_FIXTURE"}}];

  async respond(input: RequestInfo | URL, init?: RequestInit) {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== "https://api.twelvelabs.io") throw new Error("unexpected recipient");
    const path = new URL(request.url).pathname.replace(/^\/v1\.3/, "");
    const method = request.method;
    const form = request.headers.get("content-type")?.startsWith("multipart/") ? await request.formData() : undefined;
    const body = form ? "" : await request.text();
    const metadata = form?.get("user_metadata");
    const operation = typeof metadata === "string" ? JSON.parse(metadata).operationId : request.headers.get("Idempotency-Key") ?? undefined;
    this.requests.push({method,path,body,operation});
    this.onRequest();
    if (request.headers.get("x-api-key") !== "synthetic-twelve") return Response.json({}, {status:401});
    if (method === "POST" && path === "/assets") {
      if (form?.get("method") !== "direct" || !(form.get("file") instanceof Blob)) return Response.json({}, {status:400});
      const id = (this.creates.length + 1).toString(16).padStart(24,"0");
      this.assets.add(id);
      this.assetOperations.set(id,operation);
      this.creates.push(id);
      if (this.lost) throw new TypeError("connection closed after create");
      return Response.json({_id:id,status:"processing"}, {status:201});
    }
    const [,resource,id,links] = path.split("/");
    if (resource === "assets" && id) {
      if (!this.assets.has(id)) return Response.json({}, {status:404});
      if (method === "GET" && links) {
        if (this.unreadableLinks) return Response.json({}, {status:403});
        return Response.json({data:links === "entities" && this.entityLinked ? [{_id:"foreign-entity"}] : [],page_info:{total_page:1}});
      }
      if (method === "GET") return Response.json({_id:id,user_metadata:{operationId:this.wrongOwner ? "unrelated" : this.assetOperations.get(id)},status:this.queued ? "processing" : "ready"});
      if (method === "DELETE") {
        if (this.denyDeletion) return Response.json({}, {status:403});
        if (this.linked && new URL(request.url).searchParams.get("force") !== "true")
          return Response.json({code:"asset_has_linked_resources"}, {status:409});
        this.assets.delete(id);
        return new Response(null, {status:200});
      }
    }
    if (path === "/analyze/tasks" && method === "POST") {
      const params = JSON.parse(body);
      if (params.video?.asset_id && !this.assets.has(params.video.asset_id)) return Response.json({}, {status:404});
      const taskId = (this.tasks.size + 100).toString(16).padStart(24,"0");
      if (params.analysis_mode !== "time_based_metadata" && ++this.grades > this.quotaAfter)
        return Response.json({code:"insufficient_quota"}, {status:422});
      this.tasks.set(taskId, params);
      this.tasksCreated.push(params);
      return Response.json({task_id:taskId,status:"queued"}, {status:202});
    }
    if (path.startsWith("/analyze/tasks/")) {
      const taskId = path.slice("/analyze/tasks/".length);
      const task = this.tasks.get(taskId);
      if (!task) return Response.json({}, {status:404});
      if (method === "DELETE") {
        if (this.queued) return Response.json({}, {status:409});
        this.tasks.delete(taskId);
        return new Response(null,{status:200});
      }
      const def = (task.response_format as {segment_definitions?:{id:string;fields:{type:string;name:string}[]}[]})?.segment_definitions?.[0];
      const segments = def?.fields.some(f=>f.type==="time_array") ? [{start_time:1,end_time:5,metadata:{
        lines:[{start_time:1,end_time:2,line:"First."},{start_time:3,end_time:5,line:"Next."}]}}] : this.segments;
      return Response.json({task_id:taskId,custom_id:task.custom_id,status:this.queued ? "processing" : "ready",
        result:{data:JSON.stringify(def ? {[def.id]:this.empty ? [] : segments} : verdict)},
        ...(this.partial && def && {error:{message:"The result may be incomplete."}})});
    }
    if (path === "/analyze" && method === "POST") {
      if (++this.grades > this.quotaAfter) return Response.json({code:"insufficient_quota"}, {status:422});
      return Response.json({data:JSON.stringify(verdict)});
    }
    throw new Error("unexpected request: " + method + " " + path);
  }
}
export const verdict = {accepted:true,title:"Fixture",kind:"fixture",summary:"Checked.",importance:"high"};
