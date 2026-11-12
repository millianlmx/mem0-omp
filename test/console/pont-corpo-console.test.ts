// Feature pont-corpo-console : les propositions nées des signalements de collègues
// arrivent dans « Propositions » des apps Mac et iOS (comptées au badge), et les
// accepter les confirme vers leur dépôt, au seul appareil approbateur. Les apps n'ont
// pas de client à elles pour les signalements : elles passent par les propositions du
// serveur, dont la garde vérifie la composition et le refus de tout autre appareil.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT } from "../support/repo.ts";

const CONSOLE = path.join(ROOT, "omp-console");
const read = (...parts: string[]) => fs.readFileSync(path.join(CONSOLE, ...parts), "utf8");
/** Le code sans ses commentaires : un nom cité en commentaire ne câble rien. */
const code = (source: string) =>
  source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("///"))
    .join("\n");

test("pont-corpo-console/AC-1 : « Propositions » montre les signalements dans les deux apps, comptés au badge, et rien pour un client restreint", () => {
  // Le serveur compose les propositions : chaque signalement proposé en devient une, au propriétaire seul.
  const proposals = fs.readFileSync(path.join(ROOT, "omp-harness", "proposals.ts"), "utf8");
  assert.match(proposals, /add\(\{ source: "signal", signalId: signal\.id \}/);
  assert.match(
    proposals,
    /if \(proposal\.source === "signal" \|\| proposal\.source === "jira"\) return reader\.owner && scoped;/,
  );
  // La même vue sert le Mac et l'iPhone/iPad.
  assert.match(code(read("Sources", "OMPConsole", "OS", "OSRootView.swift")), /OSProposalsView\(server: server/);
  assert.match(code(read("ios", "OMPConsoleIOS", "IOSOSRootView.swift")), /OSProposalsView\(server: server/);
  // Le badge de « Propositions » compte ce que le serveur propose.
  assert.match(
    code(read("Sources", "ConsoleUI", "OS", "OSThreadList.swift")),
    /\.badge\(proposals\.proposals\.count\)/,
  );
});

test("pont-corpo-console/AC-2 : accepter un signalement le confirme vers son dépôt, et le serveur refuse tout autre appareil que l'approbateur", () => {
  assert.match(
    code(read("Sources", "ConsoleUI", "OS", "OSProposalsView.swift")),
    /await proposals\.accept\(proposal\)/,
  );
  const proposals = fs.readFileSync(path.join(ROOT, "omp-harness", "proposals.ts"), "utf8");
  assert.match(
    proposals,
    /case "signal": \{[\s\S]*?if \(!by\.client\.approver\) throw new HarnessError\(403, APPROVER_ONLY\);[\s\S]*?this\.#hooks\.signals\.confirm\(cause\.signalId, input, by\.client, actor\)/,
  );
  // Le refus du serveur reste reconnu : son 403 porte le fragment de l'approbateur.
  const signals = fs.readFileSync(path.join(ROOT, "omp-harness", "corporate", "signals.ts"), "utf8");
  assert.match(signals, /if \(!client\.approver\) throw new HarnessError\(403, APPROVER_ONLY\)/);
});
