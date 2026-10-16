// Contrat de feature : sections, verdict de revue, suite du pipeline.


// Contrat unique de la feature active, relatif à la racine du dépôt (même
// convention que .omp/mem0-brief.md). Une seule feature active à la fois : un
// nouveau cycle /req réécrit le contrat.
//
// Depuis l'isolation en worktree, ce chemin est RELATIF AU CWD : le cwd de la
// session est le worktree de la feature, donc le contrat vit sur la branche de la
// feature. Deux features ouvertes en parallèle ont deux cwd, donc deux contrats.
//
// Sections, dans cet ordre — chaque id référence celui dont il descend :
//   ## Besoins                B-<n>
//   ## Critères d'acceptation AC-<n> (B-<m>) : Given/When/Then (écrits par /req)
//   ## Documentation          doc externe rassemblée par /specs
//   ## Spécifications         S-<n> (AC-<m>) : comportement observable
//   ## Lots                   BR-<n> — type: ui | archi | aucun — sert AC-<m>
//   ## Revue                  verdict de /review — écrit par /review SEUL
//   ## Corrections            levées de /impl --fix (jamais dans `## Revue`)
//
// `## Revue` est le SEUL support du verdict : /impl --fix y lit les bloquants
// (entrée), mais n'y écrit jamais — ses levées vont sous `## Corrections`. Sans
// cette séparation, un /review qui rend la main sans écrire laissait juger la
// feature sur le texte laissé par /impl --fix : le pilote lit le verdict APRÈS le
// run de revue, et une section inchangée vaut « illisible ».
export const CONTRACT_PATH = ".omp/pipeline/contract.md";


// ---------------------------------------------------------------------------
// Fin de maillon — la suite du pipeline est ANNONCÉE dans le transcript.
// ---------------------------------------------------------------------------
// Chaque maillon (/req, /specs, /impl, /review) se termine par une retombée
// TERMINALE du fil principal (session_stop, cf. `## Documentation` §1a) : c'est le
// seul instant où « la phase est finie » est vrai. L'extension y poste la
// commande EXACTE de la suite — l'utilisateur n'a plus à se souvenir de l'ordre du
// pipeline, ni à relire le contrat pour savoir si /review a laissé des bloquants.
//
// Message d'AFFICHAGE (pi.sendMessage, triggerTurn:false), jamais un toast : un
// notify disparaît au redraw et ne serait relisible nulle part (le critère exige
// la relecture après coup).
//
// Ces prédicats sont PURS — aucun accès disque, aucun état : le handler
// `session_stop` lit le contrat lui-même et leur en passe le contenu.

export type PipelinePhase = "req" | "specs" | "impl" | "review" | "release";

export type NextStep = { kind: "command"; command: string } | { kind: "cycle-end" };


// Ligne normalisée des règles de lecture du verdict : /review écrit en Markdown,
// donc les marques de mise en forme (gras, italique, code, dièses) sautent, puis
// la puce et les espaces de bord. Sans ça, `- **BLOQUANTS** : aucun` serait
// illisible et le cycle repartirait en /review.
export function normalizeLine(line: string): string {
  return line
    .replace(/[*_`#]/g, "")
    .replace(/^[\s\-+•]+/, "")
    .replace(/\s+$/, "");
}


/** Le contrat porte-t-il la section `## <titre>` ? (`titre` sans les dièses) */
export function contractHasSection(contract: string, title: string): boolean {
  return contract.split("\n").some((line) => line.trim() === `## ${title}`);
}


/** Le titre de la section que l'arbitrage d'un pilote ajoute au contrat (S-5). */
export const PILOT_ARBITRATION_TITLE = "Arbitrages du pilote";


/**
 * Le contrat augmenté d'un arbitrage de pilote (S-5) : la section
 * `## Arbitrages du pilote` est créée en fin de fichier si elle manque, puis
 * `### Arbitrage du <ISO UTC à la seconde>` et le texte s'ajoutent en fin de cette
 * section — avant le `## ` suivant, ou en fin de fichier. PURE : le contenu d'origine
 * est conservé octet pour octet en amont du point d'insertion, et `contract === null`
 * vaut un fichier absent.
 */
export function appendPilotArbitrage(contract: string | null, text: string, at: Date): string {
  let out = contract ?? "";
  const heading = `## ${PILOT_ARBITRATION_TITLE}`;
  if (!contractHasSection(out, PILOT_ARBITRATION_TITLE)) {
    out += `${out !== "" && !out.endsWith("\n") ? "\n" : ""}\n${heading}\n\n`;
  }
  const lines = out.split("\n");
  let head = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if ((lines[i] as string).trim() === heading) {
      head = i;
      break;
    }
  }
  let end = lines.length;
  for (let i = head + 1; i < lines.length; i += 1) {
    if ((lines[i] as string).trimStart().startsWith("## ")) {
      end = i;
      break;
    }
  }
  // Le décalage du `## ` suivant (ou la fin du fichier : le dernier élément n'a pas de `\n`).
  const offset = Math.min(
    lines.slice(0, end).reduce((sum, line) => sum + line.length + 1, 0),
    out.length,
  );
  let before = out.slice(0, offset);
  if (!before.endsWith("\n")) before += "\n";
  if (!before.endsWith("\n\n")) before += "\n";
  const stamp = at.toISOString().replace(/\.\d{3}Z$/, "Z");
  return `${before}### Arbitrage du ${stamp}\n\n${text.trim()}\n\n${out.slice(offset)}`;
}


/**
 * Corps d'une section `## <titre>` : de son titre à la prochaine section `## `.
 * La DERNIÈRE occurrence fait foi : un maillon qui AJOUTE une section au lieu de
 * remplacer l'ancienne (cas mesuré d'une `## Revue`) doit être lu — garder la
 * première ferait juger la feature sur un verdict périmé, avec des bloquants
 * fantômes jusqu'au plafond.
 */
export function contractSection(contract: string, title: string): string | null {
  const lines = contract.split("\n");
  let head = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if ((lines[i] as string).trim() === `## ${title}`) {
      head = i;
      break;
    }
  }
  if (head === -1) return null;
  const body: string[] = [];
  for (const line of lines.slice(head + 1)) {
    if (line.trimStart().startsWith("## ")) break;
    body.push(line);
  }
  return body.join("\n");
}


const LOT_HEAD = /^\s*(?:#{1,6}\s+|[-*]\s+)?(?:\*\*)?\s*(BR-\d+)(?:\s*—|\s+[–-](?=\s))\s*type\s*:/;

/**
 * Les ids `BR-<n>` de la section `## Lots` (dernière occurrence), dans l'ordre et sans
 * doublon, reconnus sur les lignes d'en-tête de lot `BR-<n> — type : …` (S-13). Le
 * séparateur est le tiret cadratin, avec ou sans espaces, ou un demi-cadratin / tiret
 * simple ENTOURÉ d'espaces : le tiret interne de `BR-<n>` n'est jamais un séparateur.
 */
export function contractLots(contract: string): string[] {
  const body = contractSection(contract, "Lots");
  if (body === null) return [];
  const ids: string[] = [];
  for (const line of body.split("\n")) {
    const id = LOT_HEAD.exec(line)?.[1];
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  return ids;
}


const AC_HEAD = /^\s*(?:[-*]\s+)?(?:\*\*)?\s*(AC-\d+)(?![0-9])/;

/**
 * Les ids `AC-<n>` de la section `## Critères d'acceptation` (dernière occurrence),
 * dans l'ordre et sans doublon, reconnus sur la TÊTE de chaque ligne (S-10).
 */
export function contractAcIds(contract: string): string[] {
  const body = contractSection(contract, "Critères d'acceptation");
  if (body === null) return [];
  const ids: string[] = [];
  for (const line of body.split("\n")) {
    const id = AC_HEAD.exec(line)?.[1];
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  return ids;
}


/**
 * La tête d'une spécification : `S-<n>` est la forme demandée, mais `/specs` écrit
 * aussi `SP-<n>` et `SPEC-<n>` (mesuré sur les contrats réels : 126 S, 38 SP, 25 SPEC) —
 * les trois sont des spécifications, sinon tout AC est tenu pour non couvert.
 */
const SPEC_HEAD = /^\s*(?:#{1,6}\s+|[-*]\s+)?(?:\*\*)?\s*((?:S|SP|SPEC)-\d+)(?![0-9])/;

/**
 * Les AC du contrat qu'AUCUN bloc de `## Spécifications` ne référence (S-10) : un bloc
 * court de la tête `S-<n>` à la tête suivante ; aucune expansion de plage
 * (`AC-1..AC-4` ne référence que AC-1 et AC-4).
 */
export function uncoveredAcIds(contract: string): string[] {
  const ids = contractAcIds(contract);
  if (ids.length === 0) return [];
  const blocks = idBlocks(contractSection(contract, "Spécifications") ?? "", SPEC_HEAD);
  return ids.filter((id) => {
    const reference = new RegExp(`(?<![A-Za-z0-9])${id}(?![0-9])`);
    return !blocks.some(([, block]) => reference.test(block));
  });
}


// Libellés du verdict de /review (REVIEW_DIRECTIVE), dans l'ordre où ils sont
// écrits : ils bornent le corps du champ BLOQUANTS — le champ suivant n'est pas un
// bloquant, et une recommandation n'en est jamais un.
export const REVIEW_LABELS = ["STATUT", "AC PAR AC", "SPEC PAR SPEC", "BLOQUANTS", "RECOMMANDATIONS", "DÉCISION FINALE"];


export function isReviewLabel(line: string): boolean {
  const n = normalizeLine(line).toUpperCase();
  return REVIEW_LABELS.some((label) => n.startsWith(label));
}


// « Aucun bloquant » s'écrit de plusieurs façons selon la plume de l'agent : les
// reconnaître toutes évite de renvoyer l'utilisateur en /impl --fix pour rien.
export const VACUOUS: Record<string, true> = {
  aucun: true,
  aucune: true,
  néant: true,
  "n/a": true,
  none: true,
  "0": true,
  "-": true,
  "—": true,
  "–": true,
  "(aucun)": true,
};


// Un jeton vacuous SUIVI de la chose absente, et rien d'autre. C'est ce qui
// sépare « Aucun bloquant. » (propre) de « Aucune spec n'est couverte »
// (bloquant) : la première s'arrête là, la seconde continue sur une phrase. Le
// quantifié est donc borné à un vocabulaire de constat, jamais à une proposition.
const VACUOUS_HEAD =
  /^(aucun|aucune|néant|none|0|n\/a)\b\s*(\([^)]*\))?\s*(bloquants?|points?(\s+bloquants?)?|probl[èe]mes?|r[ée]serves?|remarques?|[ée]carts?)?\s*(identifi[ée]s?|restants?|consign[ée]s?|trouv[ée]s?|d[ée]tect[ée]s?|list[ée]s?|lev[ée]s?)?\s*[.!:;,—–-]*\s*$/i;


// Constat d'absence qui NOMME le bloquant, puis CONTINUE : après `;`, `,`, `—`,
// `(` ou une conjonction (`Aucun bloquant ; voir recommandations`, `Aucun
// bloquant mais AC-2 reste à prouver`). Ce qui suit n'est pas lu : la ligne est
// AMBIGUË — ni propre (le texte peut cacher une réserve), ni bloquante (rien
// d'actionnable) — et le verdict est illisible, à réécrire. Un jeton nu suivi
// d'un texte (`0 ; manque le test AC-2`) reste un bloquant.
const AMBIGUOUS_ABSENCE =
  /^(?:aucun|aucune|néant|none|0|n\/a)\s+(?:points?\s+)?bloquants?(?:\s+(?:identifi[ée]s?|restants?|consign[ée]s?|trouv[ée]s?|d[ée]tect[ée]s?|list[ée]s?|lev[ée]s?))?\s*(?:[;,—–(]|\b(?:mais|sauf|hormis|except[ée]|à part)\b)/i;


/**
 * Une ligne de champ qui ne consigne RIEN. Trois formes : vide, jeton seul
 * (`aucun`, `néant`, `0`, `(aucun)`…), jeton suivi d'un constat (`Aucun
 * bloquant.`, `aucun (tous levés)`, `0 (les 2 bloquants précédents sont levés)`).
 * Une ligne BARRÉE non numérotée (`~~…~~`) compte comme levée : c'est ainsi qu'une
 * relecture annule un bloquant sans réécrire la phrase.
 */
export function isVacuous(line: string): boolean {
  const n = normalizeLine(line).replace(/[.!]$/, "").trim();
  if (n === "" || VACUOUS[n.toLowerCase()] === true) return true;
  if (/^~~.*~~$/.test(n)) return true;
  return VACUOUS_HEAD.test(n);
}


/**
 * Une ligne de champ AMBIGUË : un constat d'absence suivi d'un texte, ou une ligne
 * numérotée barrée (`1. ~~…~~` : le numéro dit « à traiter », le barré dit
 * « levé »). Ni propre ni bloquante : le verdict est illisible et la revue le
 * réécrit au format exact.
 */
export function isAmbiguous(line: string): boolean {
  const n = normalizeLine(line).replace(/[.!]$/, "").trim();
  if (/^\d+[.)]\s+~~.*~~$/.test(n)) return true;
  return AMBIGUOUS_ABSENCE.test(n);
}


/**
 * Le corps du champ `<label>` d'une `## Revue`, ou `null` si le champ est absent.
 * Le corps s'arrête au libellé suivant (une RECOMMANDATION n'est pas un bloquant)
 * et au titre de section suivant. Un `(n)` entre le libellé et les deux-points est
 * toléré et ignoré.
 */
function reviewField(section: string, label: string): string[] | null {
  const lines = section.split("\n");
  const head = new RegExp(`^${label}\\s*(?:\\(\\s*\\d+\\s*\\))?\\s*(?::|：|$)`, "i");
  const at = lines.findIndex((line) => head.test(normalizeLine(line)));
  if (at === -1) return null;
  const first = normalizeLine(lines[at] as string);
  const sep = new RegExp(`^${label}\\s*(?:\\(\\s*\\d+\\s*\\))?\\s*(?::|：)?`, "i").exec(first) as RegExpExecArray;
  const body = [first.slice(sep[0].length)];
  for (const line of lines.slice(at + 1)) {
    if (line.trimStart().startsWith("## ") || isReviewLabel(line)) break;
    body.push(line);
  }
  return body;
}


export type AcStatus = "pass" | "fail" | "missing" | "unknown";

export type AcTableRow = { id: string; status: AcStatus };

// Séparateurs d'une ligne `AC-n → test (fichier:ligne) → pass/fail` : la flèche
// de la directive, ses variantes ASCII, et la barre d'un tableau Markdown.
const AC_ROW_SEP = /\s*(?:→|⇒|->|=>|\|)\s*|\s+[:：]\s+/;


// Un statut se lit en TÊTE d'une cellule (« pass (C-3 non prouvé sur iPad) » est un
// succès commenté, pas une absence de test) ; une cellule sans tête de statut est un
// commentaire, on remonte à la précédente.
const AC_LEAD_FAIL = /^(?:fail(?:ed|s|ing)?|échec|echec|échoue|ko|rouge|red)\b/;
const AC_LEAD_MISSING = /^(?:aucun test|sans test|pas de test|non test|non prouv|manquant|absent|missing|introuvable)/;
const AC_LEAD_PASS = /^(?:pass(?:ed|es|e)?|ok|vert|green|succ[èe]s|r[ée]ussi)\b/;


/** Le statut d'un AC : la dernière cellule de sa ligne qui COMMENCE par un statut ; sinon inconnu. */
function acStatusOf(cells: string[]): AcStatus {
  for (let i = cells.length - 1; i >= 0; i -= 1) {
    const c = (cells[i] as string).toLowerCase();
    if (AC_LEAD_FAIL.test(c)) return "fail";
    if (AC_LEAD_MISSING.test(c)) return "missing";
    if (AC_LEAD_PASS.test(c)) return "pass";
  }
  return "unknown";
}


/**
 * La table `AC PAR AC` de la DERNIÈRE `## Revue` : une ligne par `AC-<n>` en tête
 * de ligne, dans l'ordre (la dernière occurrence d'un id fait foi). Tolérant :
 * `AC-n :`, flèches `→`/`->`, barres de tableau ; « aucun test »/« sans test »
 * vaut `missing`. Vide si la section ou le champ manque.
 */
export function reviewAcTable(contract: string): AcTableRow[] {
  const section = contractSection(contract, "Revue");
  if (section === null) return [];
  const body = reviewField(section, "AC PAR AC");
  if (body === null) return [];
  const rows = new Map<string, AcStatus>();
  for (const raw of body) {
    const line = normalizeLine(raw).replace(/^\|\s*/, "").trim();
    const m = /^(AC-\d+)(?![0-9])\s*[:：]?\s*(.*)$/.exec(line);
    if (m === null) continue;
    const cells = (m[2] as string).split(AC_ROW_SEP).map((cell) => cell.trim()).filter((cell) => cell !== "");
    rows.set(m[1] as string, acStatusOf(cells));
  }
  return [...rows].map(([id, status]) => ({ id, status }));
}


/**
 * Les bloquants que la table `AC PAR AC` IMPLIQUE, même quand le champ
 * `BLOQUANTS` dit « aucun » : un AC en `fail` ou `missing`, et un AC du contrat
 * absent de la table (quand une table existe — sans table, rien n'est croisé).
 * Libellés tels que /impl --fix les lira.
 */
export function reviewImpliedBlockers(contract: string): string[] {
  const table = reviewAcTable(contract);
  if (table.length === 0) return [];
  const out: string[] = [];
  for (const row of table) {
    if (row.status === "fail") out.push(`${row.id} : échec en AC PAR AC`);
    else if (row.status === "missing") out.push(`${row.id} : non prouvé en AC PAR AC (aucun test)`);
  }
  const listed = new Set(table.map((row) => row.id));
  for (const id of contractAcIds(contract)) {
    if (!listed.has(id)) out.push(`${id} : non prouvé en AC PAR AC (absent de la table)`);
  }
  return out;
}


/**
 * Lecture unique du verdict : le champ `BLOQUANTS` (explicites, ambigus) croisé
 * avec la table `AC PAR AC` (impliqués). Une ligne ambiguë rend le verdict
 * illisible SAUF si un bloquant explicite existe déjà : il y a alors de quoi
 * corriger, et la réécriture attendra la revue suivante. `blockers` = les
 * libellés, explicites (ligne normalisée) puis impliqués, vide hors `blockers`.
 */
function readReview(contract: string): { verdict: "blockers" | "clean" | "unreadable"; blockers: string[] } {
  const section = contractSection(contract, "Revue");
  if (section === null) return { verdict: "unreadable", blockers: [] };
  const body = reviewField(section, "BLOQUANTS");
  if (body === null) return { verdict: "unreadable", blockers: [] };
  const explicit = body.filter((line) => !isVacuous(line) && !isAmbiguous(line)).map((line) => normalizeLine(line).trim());
  const implied = reviewImpliedBlockers(contract);
  if (explicit.length > 0) return { verdict: "blockers", blockers: [...explicit, ...implied] };
  if (body.some(isAmbiguous)) return { verdict: "unreadable", blockers: [] };
  return implied.length > 0 ? { verdict: "blockers", blockers: implied } : { verdict: "clean", blockers: [] };
}


/**
 * Les libellés des bloquants de la dernière `## Revue`, tels que la revue
 * incrémentale les reçoit : les lignes du champ `BLOQUANTS` puis les bloquants
 * impliqués par la table `AC PAR AC`. Vide quand le verdict n'est pas `blockers`.
 */
export function reviewBlockerList(contract: string): string[] {
  return readReview(contract).blockers;
}


/**
 * Verdict du maillon /review, lu dans `## Revue`. `"unreadable"` couvre les cas
 * où il n'y a rien de sûr à lire (section absente, champ `BLOQUANTS` absent ou
 * ambigu) : dans le doute on renvoie vers /review, jamais vers /impl --fix
 * (corriger ce qui n'a pas été identifié) ni vers une fausse fin de cycle. Un
 * « aucun » contredit par la table `AC PAR AC` (échec, test absent, AC omis) est
 * un verdict à bloquants : la table est la preuve, le champ n'est que le résumé.
 */
export function reviewVerdict(contract: string): "blockers" | "clean" | "unreadable" {
  return readReview(contract).verdict;
}


/**
 * Le nombre de bloquants de la dernière `## Revue` : toute ligne non vacuous du
 * champ `BLOQUANTS` (numérotée, en puce ou phrase libre) PLUS chaque bloquant
 * impliqué par la table `AC PAR AC` (un par AC). Une ligne vide ou barrée ne
 * compte pas. Invariant : `reviewVerdict === "blockers"` ⇔ `reviewBlockers >= 1`.
 * Publié pour le panneau, il n'entre dans aucune décision du pilote.
 */
export function reviewBlockers(contract: string): number {
  return readReview(contract).blockers.length;
}


/**
 * Suite d'un maillon terminé. Pure : aucun accès disque, aucun état. Un maillon
 * dont le contrat ne porte pas `## Spécifications` renvoie vers /specs : il n'y a
 * rien à implémenter ni à réviser, et proposer /review enverrait l'utilisateur
 * vers la revue d'un travail qui n'a pas eu lieu.
 */
export function nextStepFor(phase: PipelinePhase, contract: string): NextStep {
  const hasSpecs = contractHasSection(contract, "Spécifications");
  switch (phase) {
    case "req":
      return { kind: "command", command: "/specs" };
    case "specs":
      return hasSpecs ? { kind: "command", command: "/impl" } : { kind: "command", command: "/specs" };
    case "impl":
      return hasSpecs ? { kind: "command", command: "/review" } : { kind: "command", command: "/specs" };
    case "review": {
      const verdict = reviewVerdict(contract);
      if (verdict === "blockers") return { kind: "command", command: "/impl --fix" };
      if (verdict === "clean") return { kind: "cycle-end" };
      return { kind: "command", command: "/review" };
    }
    // La livraison est le DERNIER maillon : plus rien à annoncer après elle (le
    // push et la PR sont faits par le pilote du lot, cf. `releaseArgs`).
    case "release":
      return { kind: "cycle-end" };
  }
}


/**
 * Message d'affichage annonçant la suite. Aucune notice du plugin ne doit
 * contenir « fin » comme mot isolé : elles retraversent before_agent_start, où un
 * « fin » clôturerait la collecte (cf. isPipelineNotice).
 */
export function buildNextStepNotice(phase: PipelinePhase, step: NextStep): string {
  if (step.kind === "cycle-end") {
    return (
      "[pipeline] Phase /review terminée — cycle terminé : aucun BLOQUANT consigné dans " +
      "## Revue, rien à corriger."
    );
  }
  return `[pipeline] Phase /${phase} terminée — commande suivante : ${step.command}`;
}


// « fin » comme MOT ISOLÉ (Unicode-aware), jamais la sous-chaîne : « définir »,
// « enfin », « affiner », « finir » ne clôturent pas. Une lettre adjacente
// (avant ou après) invalide le match.
export function saysFin(prompt: string): boolean {
  return /(^|[^\p{L}])fin([^\p{L}]|$)/iu.test(prompt);
}


// Les notices du plugin ([req] … et [pipeline] …) retraversent before_agent_start
// comme n'importe quel message. Elles ne sont PAS des entrées utilisateur : les
// passer au détecteur de « fin » clôturerait la collecte sur le mot « fin » du
// message d'accueil, et le préfixe `[pipeline]` d'une notice de fin de maillon
// n'immunise pas son contenu — une notice qui cite un chemin contenant « fin »
// (ex. /x/fin-de-feature) contient un « fin » isolé. Le préfixe est la seule
// marque fiable : l'utilisateur n'écrit ni « [req] » ni « [pipeline] ».
export function isPipelineNotice(prompt: string): boolean {
  const p = prompt.trimStart();
  return p.startsWith("[req]") || p.startsWith("[pipeline]");
}


/**
 * Consigne d'ÉDITION de section pour un maillon qui écrit le contrat : remplacer
 * les seules sections visées, conserver le reste à l'identique. `targets` =
 * titres SANS `## ` (ex. `["Revue"]`). Réécrire tout le fichier est ce qui a
 * effacé des sections voisines ; les sections perdues sont relevées par le
 * pilote (`lostSections`), pas par une relecture de l'agent — chaque relecture
 * intégrale coûtait un contrat entier de contexte.
 */
export function contractEditRule(targets: readonly string[]): string {
  const L = targets.map((t) => `\`## ${t}\``).join(", ");
  return (
    `Écris le contrat par ÉDITION de section, jamais en réécrivant tout le fichier : remplace UNIQUEMENT ${L} ` +
    "(ajoute à la fin du fichier une section visée qui n'existe pas encore ; crée le fichier et son dossier " +
    "s'ils n'existent pas) et conserve tout le reste du fichier à l'identique."
  );
}


/**
 * Consigne de LECTURE du contrat d'un maillon : une seule lecture, et aucune quand
 * le prompt porte déjà l'extrait utile (`lotContractExcerpt`, bloc `[extrait du
 * contrat]`). Une formulation unique vaut dans les deux cas : la graine reste pure.
 */
export function contractReadRule(what: string): string {
  return (
    `Lis le contrat ${CONTRACT_PATH} (read) : ${what}. Si un bloc \`[extrait du contrat]\` suit cette directive, ` +
    "il porte déjà ces sections : travaille dessus et n'ouvre le fichier que si une référence y manque."
  );
}


/** Borne de la section `## Documentation` dans un extrait (et consigne de /specs). */
export const DOCUMENTATION_EXCERPT_MAX = 15_000;


/** Les blocs d'une section, découpés sur une tête d'id (`S-<n>`, `BR-<n>`) : `[id, bloc]`. */
function idBlocks(body: string, head: RegExp): Array<[string, string]> {
  const blocks: Array<[string, string]> = [];
  for (const line of body.split("\n")) {
    const id = head.exec(line)?.[1];
    if (id !== undefined) blocks.push([id, line]);
    else if (blocks.length > 0) (blocks[blocks.length - 1] as [string, string])[1] += `\n${line}`;
  }
  return blocks;
}


/**
 * L'extrait du contrat qu'un run reçoit dans son prompt, à la place d'une lecture
 * intégrale (mesuré : le contrat pèse 40 % des octets lus en /impl). `null` =
 * pas d'extrait, le maillon lit le fichier (la revue juge le contrat entier).
 *
 *   specs      ⇒ Besoins + Critères d'acceptation
 *   impl BR-k  ⇒ Besoins + AC + Documentation (≤ 15 000) + les S-<n> que BR-k cite + le bloc BR-k
 *   impl seul  ⇒ Besoins + AC + Documentation (≤ 15 000) + Spécifications + Lots
 *   impl --fix ⇒ AC + Revue + Corrections
 *   release    ⇒ Besoins + AC + Revue
 *
 * Un BR-k qui ne cite aucun S-<n> reçoit les S qui servent ses AC, et à défaut la
 * section entière : un extrait vide ferait improviser l'agent.
 */
export function lotContractExcerpt(
  contract: string,
  target: { phase: PipelinePhase; fix: boolean; lotId: string | null },
): string | null {
  const parts: string[] = [];
  const section = (title: string, label = title): void => {
    const body = contractSection(contract, title);
    if (body !== null && body.trim() !== "") parts.push(`## ${label}\n${body.trim()}`);
  };
  const documentation = (): void => {
    const body = contractSection(contract, "Documentation");
    if (body === null || body.trim() === "") return;
    const text = body.trim();
    parts.push(
      text.length <= DOCUMENTATION_EXCERPT_MAX
        ? `## Documentation\n${text}`
        : `## Documentation (tronquée à ${DOCUMENTATION_EXCERPT_MAX} caractères — lis le fichier pour la suite)\n${text.slice(0, DOCUMENTATION_EXCERPT_MAX)}…`,
    );
  };
  switch (target.phase) {
    case "req":
    case "review":
      return null;
    case "specs":
      section("Besoins");
      section("Critères d'acceptation");
      break;
    case "release":
      section("Besoins");
      section("Critères d'acceptation");
      section("Revue");
      break;
    case "impl": {
      if (target.fix) {
        section("Critères d'acceptation");
        section("Revue");
        section("Corrections");
        break;
      }
      section("Besoins");
      section("Critères d'acceptation");
      documentation();
      const lot = target.lotId === null ? undefined : idBlocks(contractSection(contract, "Lots") ?? "", LOT_HEAD).find(([id]) => id === target.lotId);
      if (lot === undefined) {
        section("Spécifications");
        section("Lots");
        break;
      }
      const specs = idBlocks(contractSection(contract, "Spécifications") ?? "", SPEC_HEAD);
      const cites = (block: string, id: string): boolean => new RegExp(`(?<![A-Za-z0-9])${id}(?![0-9])`).test(block);
      let kept = specs.filter(([id]) => cites(lot[1], id));
      if (kept.length === 0) {
        const acs = [...new Set(lot[1].match(/(?<![A-Za-z0-9])AC-\d+(?![0-9])/g) ?? [])];
        kept = specs.filter(([, block]) => acs.some((ac) => cites(block, ac)));
      }
      if (kept.length === 0) section("Spécifications");
      else parts.push(`## Spécifications (extrait : ${kept.map(([id]) => id).join(", ")})\n${kept.map(([, block]) => block.trim()).join("\n\n")}`);
      parts.push(`## Lots (extrait : ${lot[0]})\n${lot[1].trim()}`);
      break;
    }
  }
  return parts.length === 0 ? null : parts.join("\n\n");
}


/**
 * Clôture neutre d'un maillon : l'agent dit que son maillon est terminé sans
 * annoncer de commande. La commande suivante, en interactif, est annoncée par
 * session_stop (`nextStepFor` / `buildNextStepNotice`), jamais par l'agent.
 */
export const MAILLON_DONE_RULE =
  "Quand ton livrable est consigné, termine ta réponse par la phrase « ce maillon est terminé » : " +
  "n'annonce et ne prescris aucune commande de pipeline, la suite est annoncée hors de cette session.";


/**
 * Message de clôture, envoyé quand l'utilisateur dit « fin ». Il fige : l'agent
 * reformule chaque besoin (B-<n>) et chaque critère d'acceptation (AC-<n>), et
 * les consigne dans le contrat. C'est après validation que les sections sont
 * (ré)éditées, donc les corrections de l'utilisateur y sont capturées — pas de
 * récap pré-validation perdu.
 */
export function buildReqHandoff(): string {
  return (
    "[req] Collecte terminée. Fige maintenant le contrat :\n" +
    "1. reformule chaque besoin clarifié en une phrase d'action autoportante, " +
    "numérotée (B-<n> : verbe précis + objet précis + contraintes validées) ;\n" +
    "2. reformule chaque critère d'acceptation validé au format " +
    "AC-<n> (B-<m>) : Given … When … Then … — une condition binaire pass/fail, chaque " +
    "besoin devant en avoir AU MOINS un ;\n" +
    `3. consigne-les dans ${CONTRACT_PATH}, sous deux titres à la suite : \`## Besoins\` ` +
    "(B-<n> numérotés) puis `## Critères d'acceptation` (AC-<n> numérotés, chacun référençant " +
    `le besoin qu'il prouve). ${contractEditRule(["Besoins", "Critères d'acceptation"])}\n` +
    "4. présente-moi le récap numéroté (besoins ET critères) pour validation. Si je corrige, " +
    "réédite ces deux sections pour qu'elles reflètent l'état validé.\n\n" +
    `Ne mets pas les besoins ni les critères en mémoire mem0 : ce contrat (${CONTRACT_PATH}) ` +
    `est leur seul support. ${MAILLON_DONE_RULE}`
  );
}
