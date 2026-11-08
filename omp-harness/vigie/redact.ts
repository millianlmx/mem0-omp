// Le caviardage d'une issue publiée par la vigie : le dépôt est PUBLIC. Fait par le
// serveur, juste avant `gh issue create` (et à chaque commentaire), quoi que la vigie
// ait écrit : un agent qui se trompe ne publie ni secret ni donnée du poste.
//
// Deux passes :
// - le poste de travail : tout texte que le serveur garde du poste (pages observées,
//   meetings, actions, profil, identités — VigieStore.workstationTexts) est retiré mot
//   pour mot, avant toute autre passe (un secret masqué casserait la correspondance) ;
// - les secrets : les familles de mem0-rs (mem0-stack/mem0-rs/src/redaction.rs, celles
//   du plugin mémoire), réécrites ici, plus ce qu'un dépôt public ne doit pas lire —
//   jetons hexadécimaux longs, chaînes à forte entropie, e-mails, la requête d'une URL,
//   les chemins personnels, les adresses du tailnet et les IP.
// Best-effort, comme mem0-rs : un secret hors motif passe. La vigie ne lit d'ailleurs du
// poste que des métadonnées (vigie/collect.ts) : cette passe est le second verrou.

export const REDACTED = "[REDACTED]";
export const POSTE = "[POSTE]";

/** Les familles de secrets de mem0-rs (redaction.rs), dans le même ordre. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[a-zA-Z0-9]{16,}/g,
  /ghp_[a-zA-Z0-9]{20,}/g,
  /AKIA[0-9A-Z]{12,}/g,
  /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g,
  /Bearer\s+[a-zA-Z0-9._-]{16,}/gi,
  /(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*["']?[^\s"']{8,}/gi,
  /sk-ant-api03-[A-Za-z0-9_-]{16,}/g,
  /sk-proj-[A-Za-z0-9_-]{16,}/g,
  /github_pat_[A-Za-z0-9_]{16,}/g,
  /xox[abep]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/g,
  /[rs]k_(?:live|test|prod)_[A-Za-z0-9]{10,}/g,
  /glpat-[A-Za-z0-9_-]{20,}/g,
  /hf_[A-Za-z0-9]{30,}/g,
  /npm_[A-Za-z0-9]{36,}/g,
  /AIza[A-Za-z0-9_-]{35,}/g,
  // Les jetons GitHub d'application et d'OAuth (`gho_`, `ghs_`, `ghu_`, `ghr_`).
  /gh[osur]_[A-Za-z0-9]{20,}/g,
];

/** `scheme://user:pass@` : le mot de passe d'une URL (mem0-rs, URL_CREDS_PATTERN). */
const URL_CREDS = /([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]*):([^/\s:@]+)@/gi;

/** Une suite de lettres, chiffres, `_` et `-` d'au moins 32 caractères : un jeton probable. */
const LONG_TOKEN = /[A-Za-z0-9_-]{32,}/g;

/** Une empreinte de commit (7 à 40 hexadécimaux) se garde : un dépôt public les montre déjà. */
const COMMIT_SHA = /^[0-9a-f]{7,40}$/i;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** La requête d'une URL (`?a=b`, jetons d'accès, identifiants de session) : retirée, le chemin reste. */
const URL_QUERY = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>`]+)\?[^\s#"'<>`)\]]*/gi;

/** `/Users/<nom>`, `/home/<nom>`, `C:\Users\<nom>` : le nom de l'utilisateur. */
const HOME_PATH = /(\/(?:Users|home))\/(?!\[)[^/\s"'`]+/g;
const WINDOWS_HOME = /([A-Za-z]:\\Users)\\[^\\\s"'`]+/g;

/** Les noms du tailnet (`machine.tailnet.ts.net`) et les IPv4 hors boucle locale. */
const TAILNET_HOST = /\b[\w-]+(?:\.[\w-]+)*\.ts\.net\b/g;
const IPV4 = /\b(?!127\.0\.0\.1\b)(?!0\.0\.0\.0\b)(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;

/** Les secrets et données personnelles d'un texte, masqués. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  out = out.replace(URL_CREDS, `$1${REDACTED}@`);
  out = out.replace(URL_QUERY, `$1?${REDACTED}`);
  // Un e-mail, sauf l'utilisateur `git` d'une URL SSH (git@github.com:moi/dépôt.git).
  out = out.replace(EMAIL, (match) => (match.startsWith("git@") ? match : "[EMAIL]"));
  out = out.replace(HOME_PATH, "$1/[USER]");
  out = out.replace(WINDOWS_HOME, "$1\\[USER]");
  out = out.replace(TAILNET_HOST, "[HOST]");
  out = out.replace(IPV4, "[IP]");
  out = out.replace(LONG_TOKEN, (match) =>
    COMMIT_SHA.test(match) || !/\d/.test(match) || !/[A-Za-z]/.test(match) ? match : REDACTED,
  );
  return out;
}

/**
 * Les textes du poste retirés d'un texte, les plus longs d'abord (un titre qui contient
 * un autre texte du poste part entier). Une URL du poste l'est aussi par son chemin, quelle
 * que soit la requête ou l'ancre qui la suit.
 */
export function redactPoste(text: string, poste: readonly string[]): string {
  const needles = new Map<string, boolean>();
  for (const value of poste) {
    needles.set(value, needles.get(value) ?? false);
    try {
      const url = new URL(value);
      if (url.pathname.length > 1) needles.set(`${url.origin}${url.pathname}`, true);
    } catch {
      /* pas une URL */
    }
  }
  let out = text;
  for (const [needle, withQuery] of [...needles].sort(([a], [b]) => b.length - a.length)) {
    if (!out.includes(needle)) continue;
    if (!withQuery) out = out.split(needle).join(POSTE);
    else {
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(`${escaped}(?:[?#][^\\s"'<>\`)\\]]*)?`, "g"), POSTE);
    }
  }
  return out;
}

/** Le texte d'une issue publique : le poste d'abord, puis les secrets. */
export function redactForIssue(text: string, poste: readonly string[]): string {
  return redactSecrets(redactPoste(text, poste));
}
