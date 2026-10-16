import { it, expect } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { loadSecrets } from "../src/env.js";

it("loads secrets without overriding and returns names only", () => {
  const f = path.join(os.tmpdir(), "sec-test.env");
  fs.writeFileSync(f, "# c\nFOO_T1=abc\nexport_not=1\nBAR_T1=\"q\"\n");
  process.env.BAR_T1 = "keep";
  expect(loadSecrets(f)).toEqual(["FOO_T1"]);
  expect(process.env.FOO_T1).toBe("abc");
  expect(process.env.BAR_T1).toBe("keep");
  expect(loadSecrets("/nonexistent")).toEqual([]);
});
