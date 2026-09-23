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
//   ## Revue                  verdict de /review ; BLOQUANTS relus par /impl --fix
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


/** Corps d'une section `## <titre>` : de son titre à la prochaine section `## `. */
export function contractSection(contract: string, title: string): string | null {
  const lines = contract.split("\n");
  const head = lines.findIndex((line) => line.trim() === `## ${title}`);
  if (head === -1) return null;
  const body: string[] = [];
  for (const line of lines.slice(head + 1)) {
    if (line.trimStart().startsWith("## ")) break;
    body.push(line);
  }
  return body.join("\n");
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


export function isVacuous(line: string): boolean {
  const n = normalizeLine(line).replace(/[.!]$/, "").trim();
  return n === "" || VACUOUS[n.toLowerCase()] === true;
}


/**
 * Verdict du maillon /review, lu dans `## Revue`. `"unreadable"` couvre les deux
 * cas où il n'y a rien à lire (section absente, champ `BLOQUANTS` absent) : dans
 * le doute on renvoie vers /review, jamais vers /impl --fix (corriger ce qui n'a
 * pas été identifié) ni vers une fausse fin de cycle.
 */
export function reviewVerdict(contract: string): "blockers" | "clean" | "unreadable" {
  const section = contractSection(contract, "Revue");
  if (section === null) return "unreadable";
  const lines = section.split("\n");
  const at = lines.findIndex((line) => /^BLOQUANTS\s*(?::|：|$)/i.test(normalizeLine(line)));
  if (at === -1) return "unreadable";
  const head = normalizeLine(lines[at]!);
  const sep = /^BLOQUANTS\s*(?::|：)?/i.exec(head)!;
  const body = [head.slice(sep[0].length)];
  for (const line of lines.slice(at + 1)) {
    if (line.trimStart().startsWith("## ") || isReviewLabel(line)) break;
    body.push(line);
  }
  return body.every(isVacuous) ? "clean" : "blockers";
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
 * Message de clôture, envoyé quand l'utilisateur dit « fin ». Il fige : l'agent
 * reformule chaque besoin (B-<n>) et chaque critère d'acceptation (AC-<n>), et
 * les écrit dans le contrat. C'est après validation que le fichier est (ré)écrit,
 * donc les corrections de l'utilisateur y sont capturées — pas de récap
 * pré-validation perdu.
 */
export function buildReqHandoff(): string {
  return (
    "[req] Collecte terminée. Fige maintenant le contrat :\n" +
    "1. reformule chaque besoin clarifié en une phrase d'action autoportante, " +
    "numérotée (B-<n> : verbe précis + objet précis + contraintes validées) ;\n" +
    "2. reformule chaque critère d'acceptation validé au format " +
    "AC-<n> (B-<m>) : Given … When … Then … — une condition binaire pass/fail, chaque " +
    "besoin devant en avoir AU MOINS un ;\n" +
    `3. écris-les (write) dans ${CONTRACT_PATH}, sous deux titres à la suite : \`## Besoins\` ` +
    "(B-<n> numérotés) puis `## Critères d'acceptation` (AC-<n> numérotés, chacun référençant " +
    "le besoin qu'il prouve) — crée le fichier et son dossier si besoin, remplace des sections " +
    "existantes sans toucher au reste ;\n" +
    "4. présente-moi le récap numéroté (besoins ET critères) pour validation. Si je corrige, " +
    "réécris le fichier pour qu'il reflète l'état validé.\n\n" +
    `Ne mets pas les besoins ni les critères en mémoire mem0 : ce contrat (${CONTRACT_PATH}) ` +
    "est leur seul support. Quand besoins et critères sont figés, lance /specs — une session de " +
    "spécification lira ce contrat et produira des specs non ambiguës, tracées vers les " +
    "critères, prêtes à implémenter d'un trait."
  );
}
