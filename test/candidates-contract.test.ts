import { describe, expect, it } from "vitest";
import { readCandidates, type Candidate, type CandidateRecording } from "../src/domain/candidates.js";

const recording: CandidateRecording = { recordingSha256: "a".repeat(64), length: "1500", unit: "video-frame", rate: {num:25,den:1} };
const actor = { engine: "finder", model: null };
const candidate: Candidate = { id:"a", start:300, end:400, precisionMs:{start:1000,end:9000}, basis:{start:"word",end:"model"},
  proposedBy:actor, label:"", reason:"", chain:[{pass:1,edge:"start",at:305,precisionMs:120,basis:"word",by:actor}] };
const doc = {schemaVersion:1, recording, candidates:[candidate]};
const invalid = {code:"USAGE", details:{reason:"invalid-candidates"}};

describe("candidates-contract", () => {
  it("preserves independent radii and the ordered chain, including an empty list", () => {
    expect(readCandidates(doc, recording, "file")).toEqual([candidate]);
    expect(readCandidates({...doc,candidates:[]},recording,"file")).toEqual([]);
  });
  it.each([
    {...doc,schemaVersion:2}, {...doc,candidates:[candidate,candidate]}, {...doc,candidates:[{...candidate,id:""}]},
    {...doc,candidates:[{...candidate,start:400}]}, {...doc,candidates:[{...candidate,end:1501}]},
    {...doc,candidates:[{...candidate,precisionMs:{start:0,end:1}}]},
    {...doc,candidates:[{...candidate,chain:[{...candidate.chain[0],pass:2}]}]},
    {...doc,candidates:[{...candidate,chain:[{...candidate.chain[0],at:325}]}]},
    {...doc,candidates:[{...candidate,score:Infinity}]}, {...doc,candidates:[{...candidate,start:1.5}]},
    {...doc,recording:{...recording,rate:{num:25,den:1,unit:"fps"}}},
    {...doc,recording:{...recording,length:"01500"}}, {...doc,recording:{...recording,rate:{num:50,den:2}}},
  ])("refuses the complete invalid document", value => {
    expect(() => readCandidates(value,recording,"file")).toThrowError(expect.objectContaining(invalid));
  });
  it("compares each component of the verified whole recording including tick duration", () => {
    const clocks: CandidateRecording[] = [
      {...recording,recordingSha256:"b".repeat(64)}, {...recording,length:"1501"},
      {...recording,rate:{num:24,den:1}}, {...recording,unit:"sample"},
      {recordingSha256:recording.recordingSha256,length:"1500",unit:"tick",tick:{num:1,den:1000}},
    ];
    for (const local of clocks) expect(() => readCandidates(doc,local,"file")).toThrowError(
      expect.objectContaining({details:{reason:"candidate-recording-mismatch"}}));
    const ticks = clocks[4]!;
    const value = {...doc,recording:ticks};
    expect(readCandidates(value,ticks,"file")).toEqual([candidate]);
    expect(() => readCandidates(value,{...ticks,unit:"tick",tick:{num:1,den:2000}},"file")).toThrow();
  });
});

it("unknown-end-tick-recording binds the built-in proposal with null length and verifies the last observed tick", async () => {
  const {RangeClock} = await import("../src/domain/range-clock.js");
  const {geminiCandidates} = await import("../src/adapters/gemini-candidates.js");
  const clock = RangeClock.wholeTicks({num:1,den:1000}, undefined, "unproven", [0,40,120]);
  const doc = geminiCandidates([{start:"00:00:00",end:"00:00:01",kind:"k",summary:"s",importance:"low"}],
    "test", clock, recording.recordingSha256);
  expect(doc.recording.length).toBeNull();
  expect(readCandidates(doc,doc.recording,"engine",clock.observedEnd)[0]?.end).toBe(121);
  const file = {...doc,recording:{...doc.recording,length:"900"}};
  expect(readCandidates(file,doc.recording,"file",clock.observedEnd)).toEqual(doc.candidates);
  expect(() => readCandidates({...file,candidates:[{...doc.candidates[0],end:122}]},doc.recording,"file",clock.observedEnd))
    .toThrowError(expect.objectContaining({details:{reason:"invalid-candidates"}}));
});

it("precision-window applies the two-frame floor and each latest radius including on ticks", async () => {
  const {RangeClock} = await import("../src/domain/range-clock.js");
  const {proposalEdges,measurementWindow,measurementSearch} = await import("../src/domain/proposal-edges.js");
  const clock = RangeClock.resolve({unit:"frames",rate:{num:25,den:1},length:1500n},{});
  const claim = proposalEdges(candidate,clock).start;
  expect(measurementWindow(claim,clock,1500)).toBe(120);
  expect(measurementWindow({...claim,precisionMs:79},clock,1500)).toBeUndefined();
  expect(measurementWindow({...claim,precisionMs:80},clock,1500)).toBe(80);
  const fractional = RangeClock.resolve({unit:"frames",rate:{num:24000,den:1001},length:100n},{});
  const claims = proposalEdges({...candidate,start:12,end:36,chain:[],precisionMs:{start:100,end:100}}, fractional);
  // Frame 12 is 500.5 ms. A boundary at 400 ms is outside the 100 ms claim.
  expect(measurementSearch(claims,"start",fractional,1500)).toEqual({width:100,minMs:401,maxMs:600});
  const ticks = RangeClock.wholeTicks({num:1,den:1000},160n,"unproven",[0,40,120]);
  expect(measurementWindow({...claim,at:40,precisionMs:119},ticks,1500)).toBeUndefined();
});

it("maps a fractional-rate model second through the released exact span and its support", async () => {
  const {RangeClock} = await import("../src/domain/range-clock.js");
  const {modelSpan,boundIndex} = await import("../src/domain/source-bound.js");
  const {geminiCandidates} = await import("../src/adapters/gemini-candidates.js");
  const clock = RangeClock.resolve({unit:"frames",rate:{num:30000,den:1001},length:3000n},{from:"31f"});
  const original = {start:"00:00:01",end:"00:00:02",kind:"k",summary:"s",importance:"high" as const};
  const span = modelSpan(clock,1,2)!;
  expect(span.start).toMatchObject({origin:"model",support:["60","91"]});
  const doc = geminiCandidates([original],"model",clock,recording.recordingSha256);
  expect(doc.candidates[0]).toMatchObject({start:Number(boundIndex(span.start)),end:Number(boundIndex(span.endExclusive))});
});
