// Lire et écrire les artefacts `.harness/` d'un worktree SANS suivre de lien.
//
// Le worktree est inscriptible par le runner : `.harness/x.md` peut être un lien
// vers le jeton du service, et `.harness` lui-même un lien vers un autre dossier.
// Chaque fichier est donc ouvert en O_NOFOLLOW, vérifié par fstat (fichier
// régulier, taille bornée), puis par `/proc/self/fd` (Linux) : le fichier ouvert
// doit être EXACTEMENT sous `<worktree réel>/.harness`, le chemin attendu et non
// celui qu'un lien aurait substitué.
import * as fs from "node:fs";
import * as path from "node:path";

/** La taille maximale d'un artefact ingéré. */
export const MAX_ARTIFACT_BYTES = 1024 * 1024;

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;

/** Le chemin réel d'un descripteur, ou `null` hors Linux. */
function fdPath(fd: number): string | null {
  try {
    return fs.readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return null;
  }
}

/** Le dossier d'artefacts attendu : `<worktree réel>/<dir>`, jamais résolu à travers `<dir>`. */
export function expectedDir(worktree: string, dir: string): string {
  return path.join(fs.realpathSync(worktree), dir);
}

/** Le dossier d'artefacts, recréé en vrai dossier s'il a été remplacé par un lien ou un fichier. */
export function ensureArtifactsDir(worktree: string, dir: string): string {
  const target = expectedDir(worktree, dir);
  let stat: fs.Stats | null = null;
  try {
    stat = fs.lstatSync(target);
  } catch {
    stat = null;
  }
  if (stat && !stat.isDirectory()) fs.rmSync(target, { force: true });
  if (!stat?.isDirectory()) fs.mkdirSync(target);
  return target;
}

function assertInside(fd: number, dir: string, name: string): void {
  const real = fdPath(fd);
  if (real !== null && real !== path.join(dir, name)) throw new Error(`artefact détourné : ${name} → ${real}`);
}

/** Le contenu d'un artefact, ou `null` (lien, pas un fichier, trop gros, absent). */
export function readArtifact(dir: string, name: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(path.join(dir, name), O_RDONLY | O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) return null;
    assertInside(fd, dir, name);
    return fs.readFileSync(fd, "utf8");
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** Écrit un artefact : l'entrée existante (lien compris) est retirée, puis créée en O_EXCL|O_NOFOLLOW. */
export function writeArtifact(dir: string, name: string, content: string): void {
  const file = path.join(dir, name);
  fs.rmSync(file, { force: true, recursive: true });
  const fd = fs.openSync(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o664);
  try {
    const real = fdPath(fd);
    if (real !== null && real !== file) {
      fs.rmSync(real, { force: true });
      throw new Error(`artefact détourné : ${name} → ${real}`);
    }
    fs.writeFileSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
}
