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
// Familles couvertes : clés `sk-` (historique, Anthropic `sk-ant-api03-`, OpenAI
// `sk-proj-`), GitHub `ghp_`/`github_pat_`, AWS `AKIA…`, JWT, `Bearer …`,
// affectations `mot-de-passe : …`, jetons Slack `xoxb-`/`xoxp-`, blocs PEM de
// clé privée entiers, et identifiants des URL `scheme://user:pass@host` (règle
// dédiée, appliquée APRÈS la boucle). Un motif qui ne correspond pas laisse le
// secret en clair : c'est le sens de « pas une garantie ».
// ---------------------------------------------------------------------------

export const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{16,}/g,
  /ghp_[a-zA-Z0-9]{20,}/g,
  /AKIA[0-9A-Z]{12,}/g,
  /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g,
  /Bearer\s+[a-zA-Z0-9._-]{16,}/gi,
  /(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*["']?[^\s"']{8,}/gi,
  // Clé Anthropic — gitleaks `anthropic-api-key` (suffixe réel : 93 caractères puis `AA`).
  /sk-ant-api03-[A-Za-z0-9_-]{16,}/g,
  // Clé OpenAI projet — gitleaks `openai-api-key` (le marqueur `T3BlbkFJ` n'est pas exigé ici).
  /sk-proj-[A-Za-z0-9_-]{16,}/g,
  // PAT GitHub fine-grained — gitleaks `github-fine-grained-pat` (`github_pat_\w{82}`).
  /github_pat_[A-Za-z0-9_]{16,}/g,
  // Jetons Slack bot (`xoxb-`) et utilisateur (`xoxp-`) — doc Slack « Tokens » : sections chiffrées séparées par `-`.
  /xox[bp]-[A-Za-z0-9-]{10,}/g,
  // Bloc PEM de clé privée ENTIER : la paire BEGIN/END est exigée, aucune borne de corps
  // (déviation assumée de gitleaks `private-key` : faux positif indolore, sous-masquage non).
  /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/g,
];

// Identifiants d'URL `scheme://user:pass@host`. Groupe 1 = schéma + `://`, conservé ;
// groupe 3 = mot de passe (au moins un caractère) ; le `@` du remplacement délimite l'hôte.
// Classe `[^/\s:@]` conforme à RFC 3986 §3.2.1 : un `@` littéral n'appartient pas au userinfo
// (seule la forme percent-encodée `%40` est valide, et elle est masquée comme le reste).
// Motif séparé : son remplacement n'est pas le littéral nu, donc il s'applique hors de la boucle.
export const URL_CREDS_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]*):([^/\s:@]+)@/gi;
export const URL_CREDS_REPLACEMENT = "$1[REDACTED]@";

export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  out = out.replace(URL_CREDS_PATTERN, URL_CREDS_REPLACEMENT);
  return out;
}
