import { expect, it } from "vitest";
import { checkDirectUpload, enginePlan } from "../src/domain/engine-plan.js";

const defaults = {file:false, model:"fixture", retention:"run", available:true, twelveAvailable:true} as const;
const argv = ["analyze", "--video", "recording.mp4", "--from", "25f", "--to", "75f"];

it.each([true, false])("plans the direct upload boundary on selected bytes, preview=%s", preview => {
  const plan = enginePlan({...defaults, preview});
  checkDirectUpload(plan, 200_000_000, argv);
  expect((plan.expected ?? plan.used)?.proposer.engine).toBe("twelvelabs");
  checkDirectUpload(plan, 200_000_001, argv);
  expect(plan.reason).toBe("media-limit");
  expect(plan.planned?.proposer.engine).toBe("twelvelabs");
  expect((plan.expected ?? plan.used)?.proposer.engine).toBe("gemini");
});

it("refuses an oversize chosen route with a replayable command and a range hint", () => {
  const plan = enginePlan({...defaults, preview:false, proposer:"twelvelabs"});
  const check = () => checkDirectUpload(plan, 200_000_001, [...argv, "--proposer=twelvelabs", "--grader", "gemini"]);
  expect(check).toThrowError(expect.objectContaining({code:"PROVIDER_LIMIT", message:expect.stringContaining("time range"),
    details:expect.objectContaining({reason:"media-limit", retryWith:[...argv, "--proposer","gemini","--grader","gemini"]})}));
  expect(plan.reason).toBeNull();
});

it.each([
  {width:1280,height:320}, {width:3000,height:720}, {width:1280,height:2400},
])("preflights unsupported picture dimensions %j",picture=>{
  const plan = enginePlan({...defaults,preview:true,grader:"twelvelabs"});
  expect(()=>checkDirectUpload(plan,42,argv,{soundOnly:false,picture,duration:10})).toThrowError(expect.objectContaining({
    code:"PROVIDER_LIMIT",details:expect.objectContaining({reason:"media-limit"}),
  }));
});
