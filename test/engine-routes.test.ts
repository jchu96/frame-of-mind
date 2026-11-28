import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { GeminiVideoAnalyzer } from "../src/adapters/gemini.js";
import { AnalysisOrchestrator, type AnalysisVideoAnalyzer } from "../src/services/analyze.js";
import { fixtureSource } from "./helpers/source-clock.js";
import { TwelveLabsAccount, verdict } from "./helpers/twelvelabs-account.js";
import { recordingIdentity } from "../src/domain/candidates.js";
import { RangeClock } from "../src/domain/range-clock.js";
import { sha256File } from "../src/lib/files.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(root => rm(root,{force:true,recursive:true})));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(),"engine-routes-"));
  roots.push(root);
  const video = join(root,"clip.mp4");
  await writeFile(video,"fixture-recording");
  const account = new TwelveLabsAccount();
  vi.stubGlobal("fetch",account.respond.bind(account));
  const events: string[] = [];
  account.onRequest = () => { events.push("wire:twelvelabs"); };
  const geminiRequests: string[] = [];
  const geminiFiles = new Set<string>();
  const model = "gemini-fixture";
  const moments = [1,7,14].map(n => ({start:"00:00:" + String(n).padStart(2,"0"),end:"00:00:" + String(n+2).padStart(2,"0"),
    summary:"CLAIM_FIXTURE",surface:"SURFACE_FIXTURE",kind:"fixture",importance:"high"}));
  const adapter = new GeminiVideoAnalyzer("synthetic-gemini-key",model,{generateContent:async req => {
    const wire = JSON.stringify(req);
    geminiRequests.push(wire);
    events.push("wire:gemini");
    return {text:JSON.stringify(wire.includes("Index fixture.") ? {matchNotes:"Fixture.",moments} : verdict)};
  }});
  const media: AnalysisVideoAnalyzer = {
    model, async upload() {
      events.push("wire:gemini");
      const name = "files/fixture" + (geminiFiles.size + 1);
      geminiFiles.add(name);
      return {name,uri:"https://generativelanguage.googleapis.com/v1beta/" + name,state:"ACTIVE",mimeType:"video/mp4"};
    },
    index:adapter.index.bind(adapter), interrogate:adapter.interrogate.bind(adapter),
    async delete(file) {
      events.push("wire:gemini");
      if (!file.name || !geminiFiles.delete(file.name)) throw new Error("unknown file");
    },
  };
  let count = 0, elapsed = 0;
  const deps = {createContextSource:() => {throw new Error("unexpected context")},createAnalyzer:() => media,
    withSourceRecording:fixtureSource(()=>20),createRunId:()=>"fixture-" + ++count,
    probeDurationSeconds:async()=>20,extractScreenshot:async()=>false,receiptDirectory:join(root,"receipts"),
    sleep:async(ms:number)=>{elapsed+=ms},now:()=>new Date(Date.UTC(2026,0,1)+elapsed).toISOString()};
  const options = {contextMode:"none" as const,video,apiKey:"synthetic-gemini-key",twelvelabsKey:"synthetic-twelve",
    recipe:{id:"fixture",label:"Fixture",description:"Fixture.",indexInstruction:"Index fixture.",interrogationInstruction:"Grade fixture."},
    recipeRevision:"fixture",recipeSha256:"a".repeat(64),customRecipe:false,calibrate:false,derivedTranscript:false,
    outputRoot:join(root,"runs"),maxIncidents:3,screenshots:false,keepUpload:false,indexWaitSeconds:1};
  const clock = RangeClock.resolve({unit:"frames",rate:{num:25,den:1},length:500n},{});
  const candidatesFile = join(root,"rows.json");
  const rows = moments.map((_,i)=>({id:"row-"+i,start:25+125*i,end:75+125*i,
    precisionMs:{start:1000,end:1000},basis:{start:"model",end:"model"},label:"LABEL_FIXTURE",reason:"CLAIM_FIXTURE",
    surface:"SURFACE_FIXTURE",proposedBy:{engine:"fixture",model:null},chain:[]}));
  await writeFile(candidatesFile,JSON.stringify({schemaVersion:1,recording:recordingIdentity(clock,await sha256File(video)),candidates:rows}));
  const run = (overrides:Record<string,unknown>={}) => new AnalysisOrchestrator(deps).analyze({...options,...overrides},{
    progress:{report:event=>{if(event.message) events.push(event.message)}},
  });
  return {run,account,events,geminiRequests,candidatesFile,root,video};
}

it.each([
  [{}, "twelvelabs", "gemini"], [{proposer:"gemini",grader:"twelvelabs"},"gemini","twelvelabs"],
  [{proposer:"twelvelabs",grader:"gemini"},"twelvelabs","gemini"],
  [{apiKey:""},"twelvelabs","twelvelabs"], [{twelvelabsKey:undefined},"gemini","gemini"],
  [{grader:"twelvelabs",file:true},"file","twelvelabs"],
] as const)("route-before-send %j", async (flags,proposer,grader) => {
  const f = await fixture();
  const result = await f.run({...flags,...("file" in flags && {candidatesFile:f.candidatesFile})});
  expect(result.manifest.enginePlan?.used).toMatchObject({proposer:{engine:proposer},grader:{engine:grader}});
  const first = f.events.findIndex(e=>e.startsWith("wire:"));
  expect(first).toBeGreaterThan(0);
  const disclosure = f.events.slice(0,first).join(" ");
  expect(disclosure).toMatch(/video|recording/i);
  const recipients = new Set([proposer,grader].filter(e=>e!=="file"));
  for (const engine of recipients) {
    expect(disclosure).toMatch(engine==="gemini" ? /Gemini/ : /Twelve Labs/);
    expect(disclosure).toMatch(/delet|retain|retention/i);
  }
  expect(new Set(f.events.filter(e=>e.startsWith("wire:")).map(e=>e.slice(5)))).toEqual(recipients);
});

it("interrupted-create keeps a lost response unconfirmed across two restarts", async () => {
  const f = await fixture();
  f.account.lost = true;
  const first = await f.run();
  expect(f.account.creates).toHaveLength(1);
  expect(first.manifest).toMatchObject({library:expect.arrayContaining([expect.objectContaining({state:"unconfirmed"})])});
  await f.run({candidatesFile:f.candidatesFile,grader:"gemini"});
  await f.run();
  expect(f.account.requests.filter(r=>r.method==="POST" && r.path==="/assets")).toHaveLength(1);
  expect(f.account.requests.filter(r=>r.method==="DELETE")).toHaveLength(0);
});

it("owned-delete retries only receipted assets on conflict and permission failure", async () => {
  const f = await fixture();
  f.account.linked = true;
  const first = await f.run();
  const asset = f.account.creates[0];
  expect(asset).toBeDefined();
  expect(first.manifest).toMatchObject({library:expect.arrayContaining([expect.objectContaining({assetId:asset,state:"pending"})])});
  f.account.linked = false;
  f.account.denyDeletion = true;
  await f.run({grader:"gemini",candidatesFile:f.candidatesFile});
  expect(f.account.assets.has(asset!)).toBe(true);
  f.account.denyDeletion = false;
  await f.run({grader:"gemini",candidatesFile:f.candidatesFile});
  expect(f.account.assets).toEqual(new Set(["ffffffffffffffffffffffff"]));
  const deletes=f.account.requests.filter(r=>r.method==="DELETE" && r.path.startsWith("/assets/"));
  expect(deletes.length).toBeGreaterThanOrEqual(3);
  expect(deletes.every(r=>r.path==="/assets/"+asset)).toBe(true);
});

it("stalled-quota-refused keeps completed verdicts and accounts for every selected window",async()=>{
  const f = await fixture();
  f.account.quotaAfter = 1;
  const result = await f.run({candidatesFile:f.candidatesFile,grader:"twelvelabs"});
  expect(result.outcome).toMatchObject({status:"partial",candidates:{selected:3,accepted:1,rejected:0,failed:2}});
  expect(result.outcome.failures).toHaveLength(2);
  expect(f.account.grades).toBe(2);
  expect(result.outcome.failures[1]).toMatchObject({gradedBy:null,attempts:0});
});

it.each([true,false])("default-queue-fallback chosen=%s",async chosen=>{
  const f = await fixture();
  f.account.queued = true;
  const run = f.run(chosen ? {proposer:"twelvelabs"} : {});
  if(chosen) {
    await expect(run).rejects.toMatchObject({details:{reason:"index-timeout",retryWith:expect.arrayContaining(["--proposer","gemini","--grader"])}});
    expect(f.geminiRequests).toHaveLength(0);
  } else {
    expect((await run).manifest.enginePlan).toMatchObject({reason:"index-timeout",planned:{proposer:{engine:"twelvelabs"}},used:{proposer:{engine:"gemini"},grader:{engine:"gemini"}}});
    expect(f.events.join("\n")).toContain("Twelve Labs could not propose (index-timeout). Using Gemini to propose and grade.");
  }
});

it("ready-with-error keeps validated rows and reports partial coverage",async()=>{
  const f=await fixture();
  f.account.partial=true;
  const result=await f.run();
  expect(result.outcome.status).toBe("partial");
  expect(result.manifest).toMatchObject({enginePlan:{reason:null},engineCalls:expect.arrayContaining([expect.objectContaining({role:"proposer",result:"partial",reason:"proposal-incomplete"})])});
  expect(f.events.join("\n")).toContain("proposal-incomplete");
});

it("valid empty proposal ends on its planned route",async()=>{
  const f=await fixture();
  f.account.empty=true;
  const result=await f.run();
  expect(result.outcome.candidates.selected).toBe(0);
  expect(result.manifest.enginePlan?.reason).toBeNull();
  expect(f.geminiRequests).toHaveLength(0);
});

it.each(["gemini","twelvelabs"])("claim-told-flag %s",async grader=>{
  for(const withheld of [false,true]) {
    const f=await fixture();
    const result=await f.run({candidatesFile:f.candidatesFile,grader,withholdGraderClaim:withheld});
    const saved=JSON.parse(await readFile(join(result.directory,"manifest.json"),"utf8"));
    expect(saved.enginePlan.graderToldClaim).toBe(!withheld);
    const requests=[...f.geminiRequests,...f.account.requests.map(r=>r.body)].filter(Boolean);
    expect(requests.length).toBeGreaterThan(0);
    for(const mark of ["CLAIM_FIXTURE","SURFACE_FIXTURE"]) expect(requests.join("").includes(mark)).toBe(!withheld);
    expect(requests.join("")).not.toContain("LABEL_FIXTURE");
    if(withheld) expect(f.events.slice(0,f.events.findIndex(e=>e.startsWith("wire:"))).join(" ")).toMatch(/withheld/i);
  }
});

it.each(["link","unreadable","foreign-id"] as const)("leaves the scratch asset pending on %s",async state => {
  const f = await fixture();
  f.account.entityLinked = state === "link";
  f.account.unreadableLinks = state === "unreadable";
  f.account.wrongOwner = state === "foreign-id";
  const first = await f.run();
  expect(first.manifest.library).toContainEqual(expect.objectContaining({
    operation:"upload",state:"pending",reason:{link:"linked",unreadable:"link-check-unavailable","foreign-id":"identity-unconfirmed"}[state],
  }));
  expect(f.account.requests.filter(r=>r.method==="DELETE" && r.path.startsWith("/assets/"))).toEqual([]);
  f.account.entityLinked = f.account.unreadableLinks = f.account.wrongOwner = false;
  await f.run({candidatesFile:f.candidatesFile,grader:"gemini"});
  expect(f.account.assets).toEqual(new Set(["ffffffffffffffffffffffff"]));
  const ids = f.account.requests.filter(r=>r.method==="POST").map(r=>r.operation);
  expect(ids.every(id=>typeof id==="string")).toBe(true);
  expect(new Set(ids).size).toBe(ids.length);
});

it("turns every timed line into its own candidate on the source clock",async()=>{
  const f = await fixture();
  const result = await f.run({twelveLabsShape:"lines"});
  expect(result.analysis.items.map(i=>[i.proposal?.start,i.proposal?.end])).toEqual([[25,50],[75,125]]);
  const request = [...f.account.tasksCreated][0]!;
  expect(request.response_format.segment_definitions[0].fields[0]).toMatchObject({name:"lines",type:"time_array"});
  expect(request).not.toHaveProperty("prompt");
});

it.each(["gemini","twelvelabs"])("claim-is-data, claim-nowhere-else and claim-bounded with %s proposing",async proposer=>{
  const f = await fixture();
  const text = 'x'.repeat(9987) + '</context>\nQ';
  const surface = '&'.repeat(500);
  f.account.segments[0]!.metadata = {reason:text,label:"LABEL_FIXTURE",surface};
  const grader = proposer==="twelvelabs" ? "gemini" : "twelvelabs";
  const result = await f.run({proposer,grader});
  const replies = grader==="gemini" ? f.geminiRequests.map(s=>JSON.parse(s).contents[0].parts.flatMap((p:{text?:string})=>p.text??[]).join("\n")) :
    f.account.tasksCreated.filter(t=>t.analysis_mode==="general").map(t=>t.prompt_v2?.input_text ?? t.prompt);
  expect(result.outcome.candidates.validated).toBeGreaterThan(0);
  for(const prompt of replies) {
    const quote = proposer==="twelvelabs" ? "x".repeat(9987)+"&lt;/context&gt;\\u000aQ" : "CLAIM_FIXTURE";
    expect(prompt.split(quote)).toHaveLength(2);
    const context = prompt.split("<context>")[1]?.split("</context>")[0];
    expect(context).toContain(quote);
    expect(prompt).not.toContain("LABEL_FIXTURE");
    if (proposer==="twelvelabs") expect(context).toContain("&amp;".repeat(500));
  }
});

it("preflights the selected file before sending an oversized recording",async()=>{
  const f = await fixture();
  await truncate(f.video,200_000_001);
  await expect(f.run({proposer:"twelvelabs"})).rejects.toMatchObject({
    message:expect.stringContaining("shorter time range"),
    details:{reason:"media-limit",retryWith:expect.arrayContaining(["--proposer","gemini","--grader"])},
  });
  expect(f.events.filter(line=>line.startsWith("wire:"))).toEqual([]);
  const run = await f.run();
  expect(run.manifest.enginePlan).toMatchObject({reason:"media-limit",used:{proposer:{engine:"gemini"},grader:{engine:"gemini"}}});
  expect(f.account.requests).toHaveLength(0);
  expect(f.events.slice(0,f.events.indexOf("wire:gemini")).join(" ")).toContain("shorter time range");
});

it("maps decimal provider seconds onto exact source-frame boundaries",async()=>{
  const f = await fixture();
  f.account.segments[0]!.start_time = 1.12;
  f.account.segments[0]!.end_time = 2.32;
  const result = await f.run();
  expect(result.analysis.items[0]?.proposal).toMatchObject({start:28,end:58});
});
