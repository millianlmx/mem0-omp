// L'ÉVIDENCE du jalon « revue propre » (S-9) : ce que le pilote soumet à l'arbitre en
// plus du corpus — le diff du worktree par rapport à HEAD, fichiers non suivis
// compris — et, pour chaque AC-<n> du contrat, les fichiers DU DIFF qui le portent.
// Seuls les fichiers modifiés ou ajoutés comptent : les ids AC-<n> repartent à 1 à
// chaque feature, un test d'une feature antérieure qui porte « AC-3 » ne prouve rien
// pour l'AC-3 de celle-ci. Le pilote revérifie lui-même cette seconde partie (arbiter.ts).
//
// Git passe EXCLUSIVEMENT par le `GitRunner` injecté (jamais `node:child_process`),
// en lecture seule : ni `add`, ni écriture d'index.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { GitResult, GitRunner } from "./git.ts";


/** La borne du diff soumis à l'arbitre, en caractères. */
export const ARBITER_DIFF_MAX_CHARS = 60_000;

/** Au-delà, un fichier n'est ni lu (diff des non suivis) ni cherché (AC → fichiers). */
export const AC_SCAN_FILE_MAX_BYTES = 1_048_576;

export type AcFiles = { id: string; files: string[] }[];

/** Combien de critères l'arbitre doit attester par une assertion de test citée. */
export const SAMPLED_AC_COUNT = 2;

export type ReviewEvidence = {
  diff: string;
  /** Les fichiers du diff (suivis modifiés et non suivis non ignorés, hors `.omp/`), triés ; `null` quand git a échoué. */
  names: string[] | null;
  /** `null` quand `git diff --name-only` ou `git ls-files` a échoué : la recherche n'a pas eu lieu. */
  acFiles: AcFiles | null;
  searchError: string | null;
  /** Les critères tirés (au plus `SAMPLED_AC_COUNT`), de façon déterministe à partir du diff : l'arbitre cite leur assertion de test. */
  sampledAcIds: string[];
};


function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
}


async function git(runGit: GitRunner, args: string[], cwd: string): Promise<GitResult> {
  try {
    return await runGit(args, cwd);
  } catch (error) {
    return { code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}


function failure(result: GitResult): string {
  return firstLine(result.stderr) || `code ${result.code}`;
}


/** Le contenu texte d'un fichier régulier du worktree (≤ 1 Mio, sans NUL), sinon `null`. */
function readScannable(worktree: string, relative: string): string | null {
  const file = path.join(worktree, relative);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > AC_SCAN_FILE_MAX_BYTES) return null;
    const buffer = fs.readFileSync(file);
    if (buffer.includes(0)) return null;
    return buffer.toString("utf8");
  } catch {
    return null;
  }
}


function nulList(stdout: string): string[] {
  return stdout.split("\0").filter((name) => name !== "");
}


/** Le nombre de lignes : une fin `\n` ne compte pas de ligne vide en plus. */
function lineCountOf(text: string): number {
  if (text === "") return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}


/** Un fichier non suivi, rendu comme un ajout : sa ligne de stat et, s'il est lisible, son bloc. */
function untrackedEntry(worktree: string, name: string): { stat: string; block: string | null } {
  const text = readScannable(worktree, name);
  if (text === null) return { stat: ` ${name} | (binaire ou > 1 Mio : contenu omis) (non suivi)`, block: null };
  const count = lineCountOf(text);
  const body = count === 0 ? [] : text.replace(/\n$/, "").split("\n").map((line) => `+${line}`);
  return {
    stat: ` ${name} | ${count} + (non suivi)`,
    block: [`diff --git a/${name} b/${name}`, "new file (non suivi)", "--- /dev/null", `+++ b/${name}`, `@@ -0,0 +1,${count} @@`, ...body].join("\n"),
  };
}


/**
 * Les critères que l'arbitre doit attester : au plus `SAMPLED_AC_COUNT` ids de `acIds`,
 * tirés par le hachage de `seed` (le diff) — le même diff tire toujours les mêmes
 * critères, un diff différent en tire d'autres : aucun AC n'est prévisiblement épargné.
 */
export function sampleAcIds(acIds: readonly string[], seed: string): string[] {
  if (acIds.length <= SAMPLED_AC_COUNT) return [...acIds];
  const digest = createHash("sha256").update(seed).digest();
  const first = digest.readUInt32BE(0) % acIds.length;
  const second = (first + 1 + (digest.readUInt32BE(4) % (acIds.length - 1))) % acIds.length;
  return [Math.min(first, second), Math.max(first, second)].map((index) => acIds[index] as string);
}


/**
 * Le diff du worktree par rapport à HEAD (suivis et non suivis non ignorés), borné
 * à `maxChars` avec une troncature annoncée, les fichiers DU DIFF (hors `.omp/`) qui
 * portent chaque `AC-<n>` de `acIds`, et les critères tirés. Un git qui échoue ne
 * lève jamais : le diff vaut `(diff indisponible : …)`, la recherche des AC échoue
 * (`acFiles: null`).
 */
export async function collectReviewEvidence(input: {
  worktree: string;
  acIds: readonly string[];
  runGit: GitRunner;
  maxChars?: number;
}): Promise<ReviewEvidence> {
  const { worktree, acIds, runGit } = input;
  const maxChars = input.maxChars ?? ARBITER_DIFF_MAX_CHARS;
  const base = ["diff", "--no-color", "--no-ext-diff"];
  const stat = await git(runGit, [...base, "--stat", "HEAD"], worktree);
  const patch = await git(runGit, [...base, "HEAD"], worktree);
  const others = await git(runGit, ["ls-files", "-z", "--others", "--exclude-standard"], worktree);

  const statLines: string[] = [];
  const blocks: string[] = [];
  const unavailable = (result: GitResult): string => `(diff indisponible : ${failure(result)})`;
  statLines.push(stat.code === 0 ? stat.stdout.trimEnd() : unavailable(stat));
  blocks.push(patch.code === 0 ? patch.stdout.trimEnd() : unavailable(patch));
  if (others.code === 0) {
    for (const name of nulList(others.stdout)) {
      const entry = untrackedEntry(worktree, name);
      statLines.push(entry.stat);
      if (entry.block !== null) blocks.push(entry.block);
    }
  } else {
    statLines.push(unavailable(others));
  }
  const whole = `### git diff --stat\n${statLines.filter((line) => line !== "").join("\n")}\n\n### Changements\n${blocks.filter((block) => block !== "").join("\n")}`;
  const diff = whole.length > maxChars ? `${whole.slice(0, maxChars)}\n(diff tronqué à ${maxChars} caractères sur ${whole.length})` : whole;
  const sampledAcIds = sampleAcIds(acIds, whole);

  const changed = await git(runGit, ["diff", "-z", "--name-only", "HEAD"], worktree);
  const failed = changed.code !== 0 ? changed : others.code !== 0 ? others : null;
  if (failed !== null) return { diff, names: null, acFiles: null, searchError: failure(failed), sampledAcIds };
  const names = [...new Set([...nulList(changed.stdout), ...nulList(others.stdout)])].filter((name) => !name.startsWith(".omp/")).sort();
  const patterns = acIds.map((id) => ({ id, files: [] as string[], pattern: new RegExp(`(?<![A-Za-z0-9])${id}(?![0-9])`) }));
  for (const name of names) {
    const text = readScannable(worktree, name);
    if (text === null) continue;
    for (const entry of patterns) if (entry.pattern.test(text)) entry.files.push(name);
  }
  return { diff, names, acFiles: patterns.map(({ id, files }) => ({ id, files })), searchError: null, sampledAcIds };
}


/** Le bloc d'évidence du prompt de l'arbitre (S-9). */
export function renderReviewEvidence(evidence: ReviewEvidence): string {
  const lines =
    evidence.acFiles === null
      ? [`- (recherche impossible : ${evidence.searchError ?? "erreur inconnue"})`]
      : evidence.acFiles.map(({ id, files }) => `- ${id} : ${files.length > 0 ? files.join(", ") : "(aucun fichier)"}`);
  return `## Diff du worktree (par rapport à HEAD, fichiers non suivis compris)\n\n${evidence.diff}\n\n## Critères et fichiers du diff\n${lines.join("\n")}`;
}
