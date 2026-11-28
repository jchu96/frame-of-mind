import {readFile, writeFile, mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect,it} from "vitest";
import {AnalysisOrchestrator} from "../src/services/analyze.js";
import {CandidateAnalysisError,analysisOutcomeSchema} from "../src/domain/analysis-outcome.js";
import {builtInRecipe} from "../src/recipes/index.js";
import {fixtureSource} from "./helpers/source-clock.js";
import {RangeClock} from "../src/domain/range-clock.js";
import {SourceReceipt} from "../src/domain/source-receipt.js";
import {rangeTranscript} from "../src/services/range-context.js";

it.each(["absolute","relative"] as const)("the %s detail clock publishes the same exact source positions", async mode => {
  for (const [num,den,from,to] of [[25,1,25,51],[30000,1001,31,62]] as const) {
    const root=await mkdtemp(join(tmpdir(),"source-analysis-"));
    try {
      const file=join(root,"media.mp4");
      await writeFile(file,"fixture");
      const source=fixtureSource(() => 60,{num,den});
      const events:string[]=[];
      let n=0;
      const orchestrator=new AnalysisOrchestrator({withSourceRecording:source,createContextSource(){throw Error();},
        createAnalyzer:()=>({model:"gemini-test",upload:async()=>({name:"files/test"}),delete:async()=>{},probeClipClock:async()=>0,
          index:async()=>({matchNotes:"fixture",moments:[1,2,3].map(i=>({start:"00:00:01",end:"00:00:02",summary:String(i),kind:"test",importance:"high" as const}))}),
          interrogate:async()=>{if (++n===3) throw new CandidateAnalysisError({code:"invalid_json",attempts:2});
            return {accepted:n===1,kind:"test",title:"cue",summary:"read 00:02:03",evidence:{timestamp:"00:00:01"}};}}),
        calibrateClipClock:async()=>({model:"gemini-test",result:mode,checkedAt:"2026-01-01T00:00:00Z",evidence:{flashFileSeconds:27,clipStartSeconds:20,reportedSeconds:mode==="absolute"?27:7}}),
        extractScreenshot:async()=>false});
      const run=await orchestrator.analyze({from:from+"f",to:to+"f",video:file,outputRoot:root,contextMode:"none",apiKey:"fixture",
        recipe:builtInRecipe("decisions"),customRecipe:false,recipeSha256:"a".repeat(64),recipeRevision:"fixture",
        maxIncidents:3,screenshots:false,keepUpload:false,derivedTranscript:false},{progress:{report:e=>{if (e.message) events.push(e.message);}}});
      const a=String(from+Math.floor(num/den)), b=String(to);
      const span={start:{unit:"video-frame",frames:a,rate:{num,den},support:[a,b],origin:"model",precisionMs:1000},
        endExclusive:{unit:"video-frame",frames:b,rate:{num,den},origin:"cut",precisionMs:0}};
      expect(run.analysis.schemaVersion).toBe(5);
      expect(run.outcome).toMatchObject({schemaVersion:2,failures:[{exactSpan:span}]});
      for (const item of run.analysis.items) {
        expect(item.candidate.exactSpan).toMatchObject(span);
        expect(item.result.evidence?.exactTime).toMatchObject(span.start);
        expect(item.result.confidenceNotes).toContain("A time in this text may be on the cut's clock.");
      }
      expect(run.manifest.proseTimeUnverified).toBe(true);
      expect(events.filter(e=>e.startsWith("Pass 2/2 [")).every(e=>e.includes(`"frames":"${a}"`))).toBe(true);
      const times=JSON.parse(await readFile(join(run.directory,"times.json"),"utf8"));
      for (const e of times.entries) expect(e.exactTime).toMatchObject(e.pointer.endsWith("/end")?span.endExclusive:span.start);
      for (const name of ["report.html","analysis.md"]) {
        const report=await readFile(join(run.directory,name),"utf8");
        expect(report).toContain("read 00:02:03");
        expect(report).toContain(`video-frame ${a}`);
        expect(report).toContain(`video-frame ${b}`);
      }
      const legacy={...run.outcome,schemaVersion:1,failures:run.outcome.failures.map(f=>({candidateOrdinal:f.candidateOrdinal,start:f.start,end:f.end,code:f.code,attempts:f.attempts}))};
      expect(analysisOutcomeSchema.safeParse(legacy).success).toBe(false);
    } finally {await rm(root,{recursive:true,force:true});}
  }
});

it("clips a known 595–615 cue on both stretches and selects only overlapping source time",()=>{
  const run=(a:number,b:number,start:number,end:number,d=0)=>{
    const clock=RangeClock.resolve({unit:"frames",rate:{num:25,den:1},length:40000n},{from:String(a),to:String(b)});
    const receipt=new SourceReceipt(clock,"a".repeat(64),7260);
    const {text}=rangeTranscript({id:"fixture",provider:"file",transport:"file",raw:{},transcript:"cue",
      transcriptCues:[{startMs:start*1000,endMs:end*1000,text:"cue"}]},d,clock,receipt);
    return {text,receipt};
  };
  const first=run(0,610,595,615), second=run(600,1200,595,615);
  expect(first.receipt.endFragments[0]).toMatchObject({state:"clipped",exactSpan:{start:{frames:"14875"},endExclusive:{frames:"15250"}}});
  expect(second.receipt.startFragments[0]).toMatchObject({state:"clipped",exactSpan:{start:{frames:"15000"},endExclusive:{frames:"15375"}}});
  expect(run(600,610,590,620).receipt.startFragments).toHaveLength(1);
  expect(run(600,610,600,620).receipt.startFragments).toHaveLength(0);
  expect(run(600,610,610,620).text).toBe("");
  expect(run(600,610,590,600).text).toBe("");
  expect(run(60,90,75,78,10).text).toBe("[00:00:05] cue");
  expect(run(120,180,122,130,-5).text).toBe("[00:00:07] cue");
});
