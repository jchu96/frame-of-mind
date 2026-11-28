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
