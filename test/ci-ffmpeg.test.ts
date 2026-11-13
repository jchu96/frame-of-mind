import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("the CI check job installs ffmpeg before its gate", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const check = workflow.split("\n  check:\n")[1]!.split("\n  auth-contract:")[0]!;
  expect(check).toMatch(/\n      - name: Install ffmpeg\n        run: sudo apt-get update && sudo apt-get install -y ffmpeg\n/);
  expect(check.indexOf("Install ffmpeg")).toBeLessThan(check.indexOf("Run pull-request gate"));
});
