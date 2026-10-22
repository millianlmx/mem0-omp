// Feature session-nudge-opt-out : MEM0_NUDGE=0 coupe la relance d'écriture de fin de
// session (runners du harness), sans toucher au reste du plugin.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { sessionNudgeEnabled } from "../../omp-mem0-memory/config.ts";
import { ROOT } from "../support/repo.ts";

test("session-nudge-opt-out/AC-1 : la relance est active par défaut, coupée par MEM0_NUDGE=0 (seul) ou MEM0_MODE=runner", () => {
  assert.equal(sessionNudgeEnabled({}), true);
  assert.equal(sessionNudgeEnabled({ MEM0_NUDGE: "1" }), true);
  assert.equal(sessionNudgeEnabled({ MEM0_NUDGE: "0" }), false);
});

test("session-nudge-opt-out/AC-2 : le hook session_stop consulte l'interrupteur à l'appel, et la fin de phase reste servie", () => {
  const source = fs.readFileSync(path.join(ROOT, "omp-mem0-memory", "extension.ts"), "utf8");
  const hook = source.slice(source.indexOf('pi.on("session_stop"'));
  assert.match(hook, /if \(!st\.nudged && sessionNudgeEnabled\(\)\)/);
  assert.ok(
    hook.indexOf("phaseStopContext") < hook.indexOf("sessionNudgeEnabled"),
    "la phase passe avant et ne dépend pas de l'interrupteur",
  );
});
