// Le brief mémoire : marqueurs de version, textes posés et provisionnement idempotent du projet.
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { AUTOSETUP } from "./config.ts";
import { projectId, rootOf } from "./state.ts";
import type { Mem0Runtime } from "./state.ts";
import { writeFileAtomic } from "./write.ts";

// ---------------------------------------------------------------------------
// Le brief — source de vérité, embarquée ici pour que l'extension reste
// autonome une fois copiée dans ~/.omp/extensions/.
// ---------------------------------------------------------------------------

export const BRIEF_VERSION = "v4";

export const BRIEF_REF_PATH = path.join(".omp", "mem0-brief.md");

export const MARKER_OPEN = `<!-- mem0:brief ${BRIEF_VERSION} -->`;

export const MARKER_CLOSE = "<!-- /mem0:brief -->";

export const MARKER_ANY = /<!--\s*mem0:brief(?:\s+v(\d+))?\s*-->/;

// Bloc court, collé dans AGENTS.md : il est dans le contexte à chaque tour,
// donc il reste court. Les détails vivent dans le fichier de référence.
export const AGENTS_BLOCK = `${MARKER_OPEN}
## Mémoire du projet

Une mémoire persistante (mem0) est branchée sur ce projet. Un rappel automatique
est injecté à chaque tour, mais il est calé sur la formulation de la demande : dès
que la conversation se déplace vers un sujet que ce rappel ne couvre pas, appelle
\`mem0_search\` **avant** de lire le code ou de proposer une solution. C'est moins
cher qu'une exploration de dépôt, et c'est la seule façon de retrouver un bug déjà
corrigé ou une décision déjà tranchée.

Appelle \`mem0_search\` en particulier avant de : débugger quelque chose qui
ressemble à du déjà-vu, trancher une question d'architecture, choisir une
convention de nommage ou de découpage, ou répondre à une question sur "comment on
fait ici".

**Mémorise** (\`mem0_add\`) : stack et choix techniques, décisions d'architecture
*avec leur raison*, conventions du dépôt qui ne sont écrites nulle part, bugs
résolus (symptôme + cause racine + correctif), exigences incontournables d'une
feature, préférences de travail exprimées par l'utilisateur.

**Ne mémorise pas** : l'état courant du code, ce qui est déjà écrit ici ou dans le
README, un raisonnement en cours, un résultat de test, du bavardage, un secret.

Un fait par appel, autoportant, rédigé tel quel — \`mem0_add\` stocke ton texte
sans le reformuler. Avant d'écrire, il cherche un souvenir proche : s'il en trouve
un, il le **complète** au lieu de créer un doublon, et te renvoie la version
fusionnée. Relis-la : si la fusion est mauvaise, réécris l'entrée avec
\`mem0_update\`.

Le dépôt fait toujours autorité contre un souvenir : s'il le contredit, le souvenir
est périmé — corrige-le (\`mem0_update\`) ou supprime-le (\`mem0_forget\`), ne
travaille pas dessus.

- **Checkpoint automatique** — au-delà de 15 explorations (read, grep, glob, lsp)
  sans écriture avec \`mem0_add\`, un message "mem0 checkpoint" t'est envoyé.
  C'est un appel à écrire : tu as collecté des informations durables, enregistre-les
  maintenant. Le compteur repart à zéro après chaque \`mem0_add\`. En fin de session,
  une relance unique te demande aussi de mémoriser ce qui a été produit — fichiers
  modifiés, ou discussion de besoins/specs/archi sans édition.

Règles complètes et exemples : \`${BRIEF_REF_PATH}\` — lis-le avant ton premier
\`mem0_add\` dans ce projet.
${MARKER_CLOSE}`;

// Directive réinjectée dans le system prompt à CHAQUE tour. Le bloc AGENTS.md
// se noie dans un long contexte ; cette ligne-ci est reposée à chaque requête
// provider, donc elle survit à la compaction et au bruit.
export const SYSTEM_DIRECTIVE = `Mémoire mem0 : le sommaire de la mémoire du projet est dans ton contexte système, et les souvenirs pertinents pour la demande en cours sont injectés à chaque tour. Traite-les comme acquis : n'explore pas le dépôt pour revérifier un point que la mémoire couvre déjà. Un sujet absent du sommaire n'est pas en mémoire — explore, puis appelle mem0_add. Appelle mem0_search uniquement pour déplier une entrée du sommaire dont le rappel n'a pas donné le texte complet. Un fait par appel, autoportant ; mem0_add déduplique tout seul. Si le dépôt contredit un souvenir, le dépôt gagne : corrige avec mem0_update. Un checkpoint peut t'être envoyé (message "mem0 checkpoint") quand tu explores trop sans écrire — c'est un signal d'écriture, pas d'erreur : appelle mem0_add immédiatement pour sauver ce que tu as appris. Traite-les comme acquis : n'explore pas le dépôt pour revérifier un point que la mémoire couvre déjà.`;

// Fichier de référence, lu à la demande par l'agent (divulgation progressive).
export const BRIEF_REFERENCE = `${MARKER_OPEN}
# Brief mémoire — règles complètes

Généré par le plugin \`omp-mem0-memory\`. Tu peux éditer ce fichier : il ne sera pas
réécrit tant que le marqueur de version en tête reste \`${BRIEF_VERSION}\`.

## Quand chercher

Le rappel automatique de début de tour est construit à partir de ta demande. Il rate
ce qui est formulé autrement. \`mem0_search\` dès que le sujet bouge : avant de
débugger un symptôme qui ressemble à du déjà-vu, avant de trancher une question
d'architecture, avant de choisir une convention, avant de répondre à "comment on
fait ici". Une recherche coûte moins qu'une lecture de dépôt.

## Ce qui mérite d'être mémorisé

- **Stack et choix techniques** — langage, framework, versions imposées, gestionnaire
  de paquets, outil de test, linter, cible de déploiement. Tout ce que tu as dû
  chercher dans le dépôt pour pouvoir travailler, et que tu chercherais encore la
  prochaine fois.
- **Décisions d'architecture** — le choix retenu *et* la raison. Une décision sans sa
  raison sera rouverte dans deux mois.
- **Conventions** — nommage, structure de dossiers, patterns imposés, ce qui est
  interdit dans ce dépôt. Surtout celles qui ne sont écrites nulle part.
- **Bugs résolus** — symptôme, cause racine, correctif. C'est la catégorie qui
  rapporte le plus : un bug qui se reproduit coûte beaucoup plus cher qu'un bug
  inédit.
- **Exigences incontournables d'une feature** — les contraintes qui doivent tenir à
  chaque itération : compatibilité descendante, limite de performance, règle métier
  non négociable, exigence d'accessibilité ou de sécurité.
- **Préférences de travail** — comment l'utilisateur veut que tu procèdes sur ce
  projet. Avec \`scope: "global"\` si c'est vrai pour tous ses projets.

## Ce qu'il ne faut pas mémoriser

L'état courant du code (il change, et le dépôt fait autorité), ce qui est déjà dans
\`AGENTS.md\` ou le README, un raisonnement intermédiaire, une tâche en cours, un
résultat de test, du bavardage. Et jamais de secret, clé, token ou donnée
personnelle — la rédaction automatique existe mais elle est approximative.

## Comment écrire un souvenir

Une idée par appel, autoportante : quelqu'un doit pouvoir la comprendre dans six mois
sans le contexte de cette conversation. Nomme les fichiers, modules et symboles.

Ton texte est stocké **tel quel** : \`mem0_add\` n'appelle pas d'extraction LLM par
défaut. Écris donc la phrase finale, pas une note à retravailler.

- OUI — \`Tests : XCTest, un fichier par type, fixtures dans Tests/Support. Pas de mocks manuels, on passe par des protocoles + implémentations de test.\`
- OUI — \`Bug écran de séance figé : cause = Timer non invalidé au dismiss de la vue. Fix = .onDisappear { timer.invalidate() }. Vérifier ce pattern sur toute vue à timer.\`
- NON — \`On a corrigé le bug du timer.\` (ni symptôme, ni cause, ni fix)
- NON — \`TabataEngine.swift fait 340 lignes.\` (périmé au prochain commit)
- NON — \`L'équipe travaille sur une architecture single-app.\` (vague, non actionnable, et déjà dit ailleurs)

Une méthode réutilisable en plusieurs étapes (déployer, débugger une catégorie
d'erreur, checklist avant release) → \`mem0_add\` avec \`kind: "procedure"\`.

## Déduplication

\`mem0_add\` cherche d'abord un souvenir proche dans le même scope. Trois issues :

- **rien de proche** → nouvelle entrée ;
- **le souvenir existant dit déjà ce que tu apportes** → rien n'est écrit, l'entrée
  existante t'est renvoyée ;
- **ton texte complète ou remplace l'existant** → l'entrée est *mise à jour* et la
  version fusionnée t'est renvoyée.

Relis toujours la fusion renvoyée. Si elle est bancale (deux faits distincts collés,
information perdue), réécris l'entrée avec \`mem0_update\` — c'est prévu pour ça.
Passe \`dedupe: false\` seulement quand tu sais que le fait doit vivre séparément.

## Quand un souvenir est faux

Le dépôt gagne toujours. Si un souvenir contredit le code réel, il est périmé :
réécris-le avec \`mem0_update\`, ou supprime-le avec \`mem0_forget\` s'il est
simplement faux.
`;

// ---------------------------------------------------------------------------
// Provisionnement du brief
// ---------------------------------------------------------------------------

export type Provision = "created" | "present" | "outdated" | "skipped" | "failed";

export type BriefStatus = { root: string; ref: Provision; agents: Provision; detail?: string };

export function versionOf(text: string): string | null {
  const m = text.match(MARKER_ANY);
  return m ? (m[1] ? `v${m[1]}` : "v1") : null;
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Idempotent et volontairement conservateur : on n'écrase jamais un fichier ou
// un bloc existant, même périmé. Une version obsolète est signalée, pas
// remplacée — sinon une édition manuelle du brief se ferait effacer en silence.
// `force` (via /mem0-brief --update) est le seul chemin qui réécrit.
export function ensureBrief(cwd: string, force = false): BriefStatus {
  const { dir, isRepo } = rootOf(cwd);
  const status: BriefStatus = { root: dir, ref: "skipped", agents: "skipped" };

  if (!AUTOSETUP && !force) { status.detail = "MEM0_AUTOSETUP=0"; return status; }
  if (!isRepo && !force) { status.detail = "pas un dépôt (ni .git ni AGENTS.md)"; return status; }

  // 1. Fichier de référence
  const refAbs = path.join(dir, BRIEF_REF_PATH);
  try {
    if (fs.existsSync(refAbs)) {
      const current = versionOf(fs.readFileSync(refAbs, "utf8"));
      if (current === BRIEF_VERSION) status.ref = "present";
      else if (force) { writeFileAtomic(refAbs, BRIEF_REFERENCE); status.ref = "created"; }
      else status.ref = "outdated";
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
      // Un marqueur d'ouverture à la bonne version ne suffit pas à dire le bloc
      // complet : sans marqueur de fermeture, `body.replace(block, …)` ne matche
      // rien. On ne l'annonce donc jamais "present" — c'est ce qui interdisait à
      // /mem0-brief --update de voir l'anomalie et de la signaler.
      if (current === BRIEF_VERSION && body.includes(MARKER_CLOSE)) {
        status.agents = "present";
      } else if (current) {
        if (force) {
          const block = new RegExp(`<!--\\s*mem0:brief[\\s\\S]*?${escapeRe(MARKER_CLOSE)}`);
          const next = body.replace(block, AGENTS_BLOCK);
          // Un remplacement qui ne change rien n'est pas une écriture : on ne
          // répare pas (réécrire depuis l'ouverture détruirait le contenu
          // utilisateur qui suit), on signale.
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

// ---------------------------------------------------------------------------
// Provisionnement — compte rendu
// ---------------------------------------------------------------------------

// Une vérification par racine de projet et par instance (`rt.provisioned`). Ce
// sont des stat/read synchrones : quelques millisecondes, rien qui justifie de
// l'asynchrone.
export function checkBrief(rt: Mem0Runtime, ctx: ExtensionContext, force = false): BriefStatus {
  const cwd = ctx?.cwd ?? process.cwd();
  const { dir } = rootOf(cwd);
  if (!force) {
    const cached = rt.provisioned.get(dir);
    if (cached) return cached;
  }
  const status = ensureBrief(cwd, force);
  rt.provisioned.set(dir, status);

  if (status.ref === "created" || status.agents === "created") {
    ctx?.ui?.notify?.(
      `[mem0] brief mémoire posé sur "${projectId(cwd)}" — ${BRIEF_REF_PATH} + bloc dans AGENTS.md`,
      "info",
    );
  } else if (status.ref === "outdated" || status.agents === "outdated") {
    ctx?.ui?.notify?.(
      "[mem0] brief en version ancienne sur ce projet — /mem0-brief --update pour le remplacer",
      "warning",
    );
  } else if (status.ref === "failed" || status.agents === "failed") {
    ctx?.ui?.notify?.(`[mem0] brief non posé : ${status.detail}`, "warning");
  }
  return status;
}
