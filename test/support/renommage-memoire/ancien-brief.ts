// Feature renommage-memoire : la logique `ensureBrief` publiée sous l'ancien nom du plugin (tag
// omp-mem0-memory-v4.4.0, brief.ts l.222-289), recopiée telle quelle avec ses constantes d'avant (marqueurs
// `mem0:brief`, version v6 ou v5). Elle prouve qu'un plugin PAS à jour, qui lit un AGENTS.md portant le
// nouveau bloc (avec sa paire inerte), n'en pose pas un second et ne change pas le fichier.
//
// Ce fichier n'est pas un test : il fait partie des fixtures d'anciens noms de la feature.
import * as fs from "node:fs";
import * as path from "node:path";

export type AncienProvision = "created" | "present" | "outdated" | "skipped" | "failed";
export type AncienBriefStatus = { root: string; ref: AncienProvision; agents: AncienProvision; detail?: string };

const BLOC = (version: "v5" | "v6"): string =>
  fs.readFileSync(new URL(`./bloc-publie-${version}.md`, import.meta.url), "utf8");

const REF_PATH = path.join(".omp", "mem0-brief.md");
const MARKER_CLOSE = "<!-- /mem0:brief -->";
const MARKER_ANY = /<!--\s*mem0:brief(?:\s+v(\d+))?\s*-->/;

function versionOf(text: string): string | null {
  const m = text.match(MARKER_ANY);
  return m ? (m[1] ? `v${m[1]}` : "v1") : null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

/** La racine du projet comme `resolveRoot` d'avant : un `.git` en remontant, sinon un AGENTS.md ici. */
function rootOf(cwd: string): { dir: string; isRepo: boolean } {
  let dir = cwd;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return { dir, isRepo: true };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { dir: cwd, isRepo: fs.existsSync(path.join(cwd, "AGENTS.md")) };
}

/**
 * `ensureBrief(cwd, force)` d'avant le renommage. `version` est la version du brief publiée (`BRIEF_VERSION`) :
 * v6 pour le plugin 4.3.0 à 4.4.0, v5 pour 2.10.1 à 4.2.0. `autosetup` est `AUTOSETUP` (actif par défaut).
 */
export function ancienEnsureBrief(
  cwd: string,
  options: { version: "v5" | "v6"; autosetup?: boolean; force?: boolean },
): AncienBriefStatus {
  const { version, autosetup = true, force = false } = options;
  const BRIEF_VERSION = version;
  const AGENTS_BLOCK = BLOC(version);
  const BRIEF_REFERENCE = `<!-- mem0:brief ${BRIEF_VERSION} -->\n# Brief mémoire — règles complètes\n`;

  const { dir, isRepo } = rootOf(cwd);
  const status: AncienBriefStatus = { root: dir, ref: "skipped", agents: "skipped" };

  if (!autosetup && !force) {
    status.detail = "MEM0_AUTOSETUP=0";
    return status;
  }
  if (!isRepo && !force) {
    status.detail = "pas un dépôt (ni .git ni AGENTS.md)";
    return status;
  }

  // 1. Fichier de référence
  const refAbs = path.join(dir, REF_PATH);
  try {
    if (fs.existsSync(refAbs)) {
      const current = versionOf(fs.readFileSync(refAbs, "utf8"));
      if (current === BRIEF_VERSION) status.ref = "present";
      else if (force) {
        writeFileAtomic(refAbs, BRIEF_REFERENCE);
        status.ref = "created";
      } else status.ref = "outdated";
    } else {
      writeFileAtomic(refAbs, BRIEF_REFERENCE);
      status.ref = "created";
    }
  } catch (err) {
    status.ref = "failed";
    status.detail = (err as Error).message;
  }

  // 2. Bloc dans AGENTS.md
  const agentsAbs = path.join(dir, "AGENTS.md");
  try {
    if (fs.existsSync(agentsAbs)) {
      const body = fs.readFileSync(agentsAbs, "utf8");
      const current = versionOf(body);
      if (current === BRIEF_VERSION && body.includes(MARKER_CLOSE)) {
        status.agents = "present";
      } else if (current) {
        if (force) {
          const block = new RegExp(`<!--\\s*mem0:brief[\\s\\S]*?${escapeRe(MARKER_CLOSE)}`);
          const next = body.replace(block, AGENTS_BLOCK);
          if (next === body) {
            status.agents = "failed";
            status.detail = `bloc mem0 sans marqueur de fermeture (${MARKER_CLOSE}) — AGENTS.md laissé intact`;
          } else {
            writeFileAtomic(agentsAbs, next);
            status.agents = "created";
          }
        } else {
          status.agents = "outdated";
        }
      } else {
        writeFileAtomic(agentsAbs, `${body}\n\n${AGENTS_BLOCK}\n`);
        status.agents = "created";
      }
    } else {
      writeFileAtomic(agentsAbs, `# AGENTS.md\n\n${AGENTS_BLOCK}\n`);
      status.agents = "created";
    }
  } catch (err) {
    status.agents = "failed";
    status.detail = (err as Error).message;
  }

  return status;
}
