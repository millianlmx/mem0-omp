// Chemins d'écriture : masquage des secrets avant envoi, et écriture de fichier atomique.
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Écriture atomique. Le plugin frère (omp-mem0-req) a le même helper, mais les
// deux plugins restent autonomes (copiables séparément) : il est réécrit ici,
// jamais importé de l'un à l'autre. Un `writeFileSync` interrompu (mort du
// process) laisse un fichier tronqué — ici l'`AGENTS.md` de l'utilisateur ou le
// registry de phases global. Le temporaire est créé dans le répertoire CIBLE :
// `renameSync` n'est atomique qu'à l'intérieur d'un même système de fichiers.
// ---------------------------------------------------------------------------

/** Exporté pour les tests. */
export function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Garde-fou secrets — best-effort avant toute écriture. Pas une garantie.
// ---------------------------------------------------------------------------

export const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{16,}/g,
  /ghp_[a-zA-Z0-9]{20,}/g,
  /AKIA[0-9A-Z]{12,}/g,
  /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g,
  /Bearer\s+[a-zA-Z0-9._-]{16,}/gi,
  /(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*["']?[^\s"']{8,}/gi,
];

export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}
