// L'empreinte d'un signal de la vigie : déterministe, sans LLM. Deux occurrences du même
// bug (même source, même emplacement, même message aux variables près) ont la même
// empreinte ; deux bugs différents, non. C'est la clé du dédoublonnage : une empreinte
// connue compte une occurrence de plus (et commente son issue), une nouvelle part au tri.
//
// Le message et l'emplacement sont normalisés : horodatages, identifiants (uuid, ids du
// harness, empreintes hexadécimales), nombres, chemins temporaires et personnels,
// adresses et ports retirés ; la casse et les blancs aplanis.
import { createHash } from "node:crypto";

/** Un signal tel que la vigie le relève, avant empreinte. */
export type Signal = {
  /** D'où il vient : `run`, `log:harness`, `client:chrome`, `health`, `memory`, `ci`, `poste`… */
  source: string;
  /** Où : l'étape d'un run, le fichier et la fonction d'une pile, l'événement du journal, le workflow… */
  location: string;
  /** Le message, brut. */
  message: string;
};

/** Le nombre d'hexadécimaux gardés de la SHA-256 : 96 bits, sans collision à l'échelle d'un serveur. */
const FINGERPRINT_HEX = 24;

const REPLACEMENTS: readonly [RegExp, string][] = [
  // 2026-11-07T10:42:00.123Z, 2026-11-07 10:42:00, 07/11/2026
  [/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g, "<ts>"],
  [/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, "<ts>"],
  [/\b\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?\b/g, "<ts>"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>"],
  // Chemins temporaires et de travail : leur nom change à chaque run.
  [/(?:\/private)?\/(?:tmp|var\/folders|var\/tmp)\/[^\s"'`:)]+/g, "<tmp>"],
  [/\/worktrees\/[^\s"'`:)]+/g, "<tmp>"],
  [/\/(?:Users|home)\/[^\s"'`:)]+/g, "<home>"],
  [/[A-Za-z]:\\Users\\[^\s"'`:)]+/g, "<home>"],
  // URL : l'hôte et le chemin restent, la requête part ; puis IP et ports.
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"'`]+)[?#][^\s"'`)]*/gi, "$1"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "<ip>"],
  // Un mot qui porte un chiffre et fait au moins 6 caractères : un identifiant (run, sha, jeton).
  [/\b(?=[A-Za-z_-]*\d)[A-Za-z0-9_-]{6,}\b/g, "<id>"],
  [/\d+(?:[.,]\d+)?/g, "<n>"],
];

/** Le texte d'un message ou d'un emplacement, sans ce qui change d'une occurrence à l'autre. */
export function normalize(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REPLACEMENTS) out = out.replace(pattern, replacement);
  return out.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 2000);
}

/** L'empreinte d'un signal : SHA-256 de sa source, de son emplacement et de son message normalisés. */
export function fingerprintOf(signal: Signal): string {
  const key = `${signal.source.trim().toLowerCase()}\n${normalize(signal.location)}\n${normalize(signal.message)}`;
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, FINGERPRINT_HEX);
}

/** Une empreinte valide : hexadécimal minuscule, 16 à 64 caractères. */
export function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{16,64}$/.test(value);
}
