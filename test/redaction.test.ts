// Tests du masquage des secrets (omp-mem0-memory/write.ts) — B-1, AC-1 à AC-8.
//
// Ce fichier existe parce que B-1 exige « chaque famille prouvée par un test » :
// le masquage est un garde-fou destructif, où un sous-masquage est le bug et un
// faux positif indolore. Chaque test porte donc l'id de son critère d'acceptation
// dans son nom, pour que la revue le retrouve par grep.
//
// ISOLATION : `write.ts` est un module pur (`node:fs`, `node:path`) sans effet de
// bord à l'import, qui ne calcule ni `$HOME` ni `AGENTS.md` — d'où l'import
// STATIQUE, contrairement à test/plugin-fs.test.ts:14-27. Aucun disque, aucune
// horloge, aucun réseau.
//
// Les justifications des classes de caractères sont dans les commentaires :
// gitleaks `config/gitleaks.toml` (pièges `(?i)`/entropie/longueur exacte),
// doc Slack « Tokens » (`xoxb-` bot / `xoxp-` user), RFC 3986 §3.2.1 (userinfo).
import test from "node:test";
import assert from "node:assert/strict";
import { redact } from "../omp-mem0-memory/write.ts";

// Fixtures partagées, réutilisées par le test d'idempotence.
const ANTHROPIC = "clé sk-ant-api03-AbCdEf0123456789_-XYZabcDEF fin";
const OPENAI_PROJ = "sk-proj-AbCdEf0123456789_-XYZabcDEF";
const GITHUB_PAT = "jeton github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN fin";
// Les deux fixtures Slack sont assemblées à l'exécution : écrites d'un seul tenant
// dans le source, elles sont détectées comme de vrais jetons par la push protection
// de GitHub (dépôt public) — y compris l'exemple de la documentation Slack — et le
// push de la branche est refusé (GH013). La forme produite reste celle de la doc
// (`xoxb-<sections chiffrées>-<secret>`, `xoxp-111-222-333-<secret>`).
const SLACK_BOT = ["xoxb", "123456789012", "1234567890123", "abcdefghijklmnopqrstuvwx"].join("-");
const SLACK_USER = ["xoxp", "111", "222", "333", "a".repeat(32)].join("-");
const PEM_RSA = "avant\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxYz1234567890abcdefGHIJKLMNOP\n+qrStuvWXyZ0123456789abcdef=\n-----END RSA PRIVATE KEY-----\napres";
const URL_PG = "postgres://admin:S3cretP4ss@db.example.com:5432/app";

test("redaction/AC-1 : clé Anthropic sk-ant-api03 masquée, préfixe compris", () => {
  const out = redact(ANTHROPIC);
  assert.equal(out, "clé [REDACTED] fin");
  assert.ok(!out.includes("sk-ant-api03-"), "le préfixe ne doit plus apparaître");
  assert.ok(!out.includes("AbCdEf0123456789_-XYZabcDEF"), "le suffixe ne doit plus apparaître");
  // Sous la longueur minimale de 16 : une mention de préfixe nu reste lisible.
  assert.equal(redact("sk-ant-api03-"), "sk-ant-api03-");
  assert.equal(redact("sk-ant-api03-abcdefghijklmno"), "sk-ant-api03-abcdefghijklmno");
});

test("redaction/AC-2 : clé OpenAI projet sk-proj masquée, préfixe compris", () => {
  const out = redact(OPENAI_PROJ);
  assert.equal(out, "[REDACTED]");
  assert.ok(!out.includes("sk-proj-"));
  assert.ok(!out.includes("AbCdEf0123456789_-XYZabcDEF"));
  assert.equal(redact("sk-proj-abcdefghijklmno"), "sk-proj-abcdefghijklmno");
  // Deux clés de familles différentes dans un même texte : le drapeau `g` masque les deux.
  assert.equal(redact(`${ANTHROPIC} puis ${OPENAI_PROJ}`), "clé [REDACTED] fin puis [REDACTED]");
});

test("redaction/AC-3 : jeton GitHub fine-grained github_pat_ masqué", () => {
  const out = redact(GITHUB_PAT);
  assert.equal(out, "jeton [REDACTED] fin");
  assert.ok(!out.includes("github_pat_"));
  assert.ok(!out.includes("11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN"));
  assert.equal(redact("github_pat_abc"), "github_pat_abc");
});

test("redaction/AC-4 : jetons Slack xoxb-/xoxp- masqués", () => {
  assert.equal(redact(SLACK_BOT), "[REDACTED]");
  assert.equal(redact(SLACK_USER), "[REDACTED]");
  assert.equal(redact(`${SLACK_BOT}, ${SLACK_USER}`), "[REDACTED], [REDACTED]");
  // Préfixes hors périmètre (B-1) : `xoxa-` et un `xox` sans tiret restent intacts.
  assert.equal(redact("xoxa-abcdefghij"), "xoxa-abcdefghij");
  assert.equal(redact("xox"), "xox");
});

test("redaction/AC-5 : bloc PEM masqué en entier (variantes, multi-blocs, bloc non terminé intact)", () => {
  const rsa = redact(PEM_RSA);
  assert.equal(rsa, "avant\n[REDACTED]\napres");
  assert.ok(!rsa.includes("-----BEGIN"), "l'en-tête ne doit pas subsister");
  assert.ok(!rsa.includes("-----END"), "le pied ne doit pas subsister");
  assert.ok(!rsa.includes("MIIEowIBAAKCAQEAxYz1234567890abcdefGHIJKLMNOP"), "le corps base64 ne doit pas subsister");

  const openssh = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ==\n-----END OPENSSH PRIVATE KEY-----";
  assert.equal(redact(openssh), "[REDACTED]");

  const pgp = "-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBG1234567890abcdef\n-----END PGP PRIVATE KEY BLOCK-----";
  assert.equal(redact(pgp), "[REDACTED]");

  const deux = `un\n${openssh}\nmilieu\n${pgp}\nfin`;
  assert.equal(redact(deux), "un\n[REDACTED]\nmilieu\n[REDACTED]\nfin");

  // Bloc non terminé : AC-5 ne porte que sur un bloc ENTIER, aucune substitution.
  const tronque = "avant\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxYz1234567890abcdef\napres";
  assert.equal(redact(tronque), tronque);
});

test("redaction/AC-6 : identifiants d'URL masqués, schéma/hôte/port/chemin conservés", () => {
  const pg = redact(URL_PG);
  assert.equal(pg, "postgres://[REDACTED]@db.example.com:5432/app");
  assert.ok(pg.includes("db.example.com:5432/app"), "hôte, port et chemin restent présents");
  assert.ok(!pg.includes("admin") && !pg.includes("S3cretP4ss"), "utilisateur et mot de passe absents");

  assert.equal(redact("redis://:S3cretP4ss@cache.local:6379/0"), "redis://[REDACTED]@cache.local:6379/0");
  assert.equal(redact("HTTPS://user:pass@HOST/X"), "HTTPS://[REDACTED]@HOST/X");
  assert.equal(redact("https://user:p%40ss@host/x"), "https://[REDACTED]@host/x");
  assert.equal(redact("a://u1:p1@h1 b://u2:p2@h2"), "a://[REDACTED]@h1 b://[REDACTED]@h2");
  // Ordre d'application : la famille de clé masque d'abord le suffixe, puis la règle URL le reste du userinfo.
  assert.equal(
    redact("https://user:sk-ant-api03-AbCdEf0123456789_-XYZabcDEF@host/x"),
    "https://[REDACTED]@host/x",
  );
});

test("redaction/AC-7 : non-régression des six familles historiques, jeton [REDACTED] stable", () => {
  assert.equal(redact("historique sk-abcdefghijklmnop1234 fin"), "historique [REDACTED] fin");
  assert.equal(redact("ghp_ABCDEFGHIJKLMNOPQRSTUVWX"), "[REDACTED]");
  assert.equal(redact("AKIAIOSFODNN7EXAMPLE"), "[REDACTED]");
  assert.equal(
    redact("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "[REDACTED]",
  );
  assert.equal(redact("Authorization: Bearer abcdefghijklmnopqrst"), "Authorization: [REDACTED]");
  assert.equal(redact("password=S3cretValue123"), "[REDACTED]");
  // Le jeton de masquage est stable : aucun motif ne le reconnaît (exigé par les flux de relecture).
  assert.equal(redact("[REDACTED]"), "[REDACTED]");
  // Idempotence sur la concaténation de toutes les familles : redact(redact(t)) === redact(t).
  const tout = [ANTHROPIC, OPENAI_PROJ, GITHUB_PAT, SLACK_BOT, SLACK_USER, PEM_RSA, URL_PG, "ghp_ABCDEFGHIJKLMNOPQRSTUVWX"].join("\n");
  const une = redact(tout);
  assert.equal(redact(une), une, "redact est idempotent");
});

test("redaction/AC-8 : aucun sur-masquage", () => {
  const intacts = [
    "https://example.com/chemin",
    "http://h.io/a?b=c",
    "https://user@host/x",
    "mailto:user@host",
    "user:pass@host/x",
    "aucun secret ici, juste du texte et un chemin /tmp/x",
  ];
  for (const t of intacts) assert.equal(redact(t), t, `entrée altérée : ${t}`);
  // Entrée vide : aucune entrée ne provoque d'exception, la sortie reste inchangée.
  assert.equal(redact(""), "");
});
