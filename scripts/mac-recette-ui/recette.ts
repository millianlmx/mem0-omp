#!/usr/bin/env node
// CLI de la recette UI Mac (recette-ui-mac-automatisee), appelée par
// scripts/mac-recette-ui.sh. Seul fichier de scripts/mac-recette-ui/ qui lit,
// écrit, appelle git ou écoute : catalogue.ts, analyse.ts, ecran.ts et
// fixture.ts sont purs.
//
//   node --experimental-strip-types scripts/mac-recette-ui/recette.ts catalogue
//     → le catalogue S-6 en JSON sur stdout, sortie 0 (lu par la sonde).
//   node --experimental-strip-types scripts/mac-recette-ui/recette.ts ecran <faits.json>
//     → sortie 0 si l'écran est exécutable ; sinon sortie 2 et la raison SEULE
//       sur stdout (S-2), que le script imprime au format de S-1.
//   node --experimental-strip-types scripts/mac-recette-ui/recette.ts analyse --sortie <d> --exceptions <f>
//     → écrit <d>/rapport.json (temporaire puis `rename`) et <d>/rapport.md,
//       imprime la dernière ligne de S-1 (✓ / ✗, rapport = <d>/rapport.md tel
//       que passé), sortie 0 (vert) ou 1 (défauts trouvés).
//   node --experimental-strip-types scripts/mac-recette-ui/recette.ts fixture --racine <R>
//     → crée le jeu fictif de S-4 sous R (absolue), écoute sur 127.0.0.1:<port
//       éphémère>, écrit R/fixture.json EN DERNIER, puis sert jusqu'à SIGTERM
//       (sortie 0). Un échec de création ou d'écoute → stderr, sortie 1.
// Tout autre usage → message sur stderr, sortie 2.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { analyser, ligneVerdict, rendreRapportMd, serialiserRapportJson } from "./analyse.ts";
import { CATALOGUE } from "./catalogue.ts";
import { RAISON_PRECONTROLE_ECHOUE, jugerEcran, lireFaitsEcran } from "./ecran.ts";
import { RouteurFixture, depotFictif, jeuFictif } from "./fixture.ts";

const USAGE = [
  "usage : recette.ts catalogue",
  "        recette.ts ecran <faits.json>",
  "        recette.ts analyse --sortie <dossier> --exceptions <fichier>",
  "        recette.ts fixture --racine <R absolue>",
].join("\n");

/** Le texte d'un fichier, ou `null` s'il n'existe pas ou ne se lit pas. */
function lireTexte(fichier: string): string | null {
  try {
    return fs.readFileSync(fichier, "utf8");
  } catch {
    return null;
  }
}

/** Le JSON d'un fichier, ou `undefined` s'il est absent ou illisible. */
function lireJson(fichier: string): unknown {
  const texte = lireTexte(fichier);
  if (texte === null) return undefined;
  try {
    return JSON.parse(texte);
  } catch {
    return undefined;
  }
}

/** Écrit par fichier temporaire puis `rename` : jamais de rapport à moitié écrit. */
function ecrireAtomique(fichier: string, contenu: string): void {
  const tmp = `${fichier}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, contenu);
  fs.renameSync(tmp, fichier);
}

function analyse(sortie: string, fichierExceptions: string): number {
  const releves = new Map<string, unknown>();
  const captures = new Set<string>();
  for (const s of CATALOGUE) {
    const releve = lireJson(path.join(sortie, "releves", `${s.id}.json`));
    if (releve !== undefined) releves.set(s.id, releve);
    const capture = path.join(sortie, "captures", `${s.id}.png`);
    if (fs.existsSync(capture) && fs.statSync(capture).size > 0) captures.add(s.id);
  }
  const rapport = analyser({
    catalogue: CATALOGUE,
    parcours: lireJson(path.join(sortie, "parcours.json")) ?? null,
    releves,
    captures,
    exceptions: lireTexte(fichierExceptions),
  });
  fs.mkdirSync(sortie, { recursive: true });
  ecrireAtomique(path.join(sortie, "rapport.json"), serialiserRapportJson(rapport));
  ecrireAtomique(path.join(sortie, "rapport.md"), rendreRapportMd(rapport));
  console.log(ligneVerdict(rapport, path.join(sortie, "rapport.md")));
  return rapport.verdict === "vert" ? 0 : 1;
}

/**
 * Crée le dépôt fictif `R/depots/atelier` et ses worktrees. La configuration git
 * de l'utilisateur et du système est écartée (signature, gabarits, crochets) et
 * les dates sont fixes : les SHA sont les mêmes à chaque passage.
 */
function creerDepot(racine: string): void {
  const depot = depotFictif();
  const dossier = path.join(racine, "depots", "atelier");
  fs.mkdirSync(dossier, { recursive: true });
  const ecrire = (fichiers: Record<string, string>): void => {
    for (const [relatif, contenu] of Object.entries(fichiers)) {
      fs.mkdirSync(path.dirname(path.join(dossier, relatif)), { recursive: true });
      fs.writeFileSync(path.join(dossier, relatif), contenu);
    }
  };
  const git = (args: string[], date?: string): void => {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: racine,
      LANG: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    if (date !== undefined) Object.assign(env, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    execFileSync(
      "git",
      ["-c", `user.name=${depot.auteur.nom}`, "-c", `user.email=${depot.auteur.courriel}`, "-c", "commit.gpgsign=false", ...args],
      { cwd: dossier, env, stdio: ["ignore", "ignore", "pipe"] },
    );
  };
  git(["init", "-q", "-b", depot.branche]);
  for (const commit of depot.commits) {
    ecrire(commit.fichiers);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", commit.message], commit.date);
  }
  for (const w of depot.worktrees) git(["worktree", "add", "-q", "-b", w.branche, path.join(racine, w.chemin), depot.branche]);
  ecrire(depot.nonCommites);
}

/**
 * Sous-commande `fixture` : dépôt, écoute, jeu (qui porte le port), puis
 * `fixture.json` en dernier ; sert jusqu'à SIGTERM. Le processus reste vivant :
 * son pid est le propriétaire du lot, du run et du service fictifs.
 */
function fixture(racine: string): void {
  const echec = (etape: string, erreur: unknown): never => {
    const detail = erreur instanceof Error ? erreur.message : String(erreur);
    console.error(`fixture : ${etape} en échec — ${detail.trim()}`);
    process.exit(1);
  };
  const debut = Date.now();
  try {
    fs.mkdirSync(racine, { recursive: true });
    creerDepot(racine);
  } catch (erreur) {
    echec("création du dépôt fictif", erreur);
  }

  const routeur = new RouteurFixture(racine, debut);
  const serveur = http.createServer((requete, reponse) => {
    let corps = "";
    requete.setEncoding("utf8");
    requete.on("data", (morceau: string) => {
      corps += morceau;
    });
    requete.on("end", () => {
      const jeton = requete.headers["x-omp-service-token"];
      const r = routeur.repondre({
        methode: requete.method ?? "GET",
        url: requete.url ?? "/",
        jetonService: typeof jeton === "string" ? jeton : undefined,
        corps,
      });
      if (r.type === "json") {
        reponse.writeHead(r.statut, { "content-type": "application/json; charset=utf-8" });
        reponse.end(JSON.stringify(r.corps));
        return;
      }
      reponse.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
      reponse.write(r.trame);
      // Le client abandonne une requête muette au bout de 30 s : un `: ping` toutes les 10 s (D-9).
      const ping = setInterval(() => reponse.write(": ping\n\n"), 10_000);
      reponse.on("close", () => clearInterval(ping));
    });
  });
  serveur.on("error", (erreur) => echec("écoute du serveur", erreur));
  serveur.listen(0, "127.0.0.1", () => {
    const adresse = serveur.address();
    if (adresse === null || typeof adresse === "string") return echec("écoute du serveur", "adresse inconnue");
    try {
      const depotReel = fs.realpathSync(path.join(racine, "depots", "atelier"));
      for (const f of jeuFictif({ racine, depotReel, pid: process.pid, port: adresse.port, debut })) {
        const cible = path.join(racine, f.chemin);
        fs.mkdirSync(path.dirname(cible), { recursive: true });
        ecrireAtomique(cible, f.contenu);
        fs.chmodSync(cible, f.mode);
      }
      fs.mkdirSync(path.join(racine, "alertes"), { recursive: true });
      ecrireAtomique(path.join(racine, "fixture.json"), JSON.stringify({ version: 1, pid: process.pid, port: adresse.port }));
    } catch (erreur) {
      echec("écriture du jeu fictif", erreur);
    }
  });
  process.on("SIGTERM", () => {
    serveur.closeAllConnections();
    serveur.close(() => process.exit(0));
  });
}

/** Le code de sortie, ou `null` quand la commande reste au service (`fixture`). */
function main(argv: string[]): number | null {
  const [commande, ...reste] = argv;
  if (commande === "catalogue" && reste.length === 0) {
    console.log(JSON.stringify(CATALOGUE));
    return 0;
  }
  if (commande === "ecran" && reste.length === 1) {
    const faits = lireFaitsEcran(lireJson(reste[0]));
    const jugement = faits === null ? { executable: false as const, raison: RAISON_PRECONTROLE_ECHOUE } : jugerEcran(faits);
    if (jugement.executable) return 0;
    console.log(jugement.raison);
    return 2;
  }
  if (commande === "analyse" && reste.length === 4) {
    const options = new Map<string, string>();
    for (let i = 0; i < reste.length; i += 2) {
      const [cle, valeur] = [reste[i], reste[i + 1]];
      if ((cle === "--sortie" || cle === "--exceptions") && !options.has(cle) && valeur !== "") options.set(cle, valeur);
    }
    const sortie = options.get("--sortie");
    const exceptions = options.get("--exceptions");
    if (sortie !== undefined && exceptions !== undefined) return analyse(sortie, exceptions);
  }
  if (commande === "fixture" && reste.length === 2 && reste[0] === "--racine" && path.isAbsolute(reste[1])) {
    fixture(reste[1]);
    return null;
  }
  console.error(USAGE);
  return 2;
}

// Chemins RÉELS : sous macOS, /var → /private/var et `import.meta.url` est résolu,
// pas `argv[1]` ; une comparaison brute ferait sortir 0 sans rien faire.
const cheminReel = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const invokedDirectly =
  process.argv[1] !== undefined && cheminReel(process.argv[1]) === cheminReel(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const code = main(process.argv.slice(2));
  if (code !== null) process.exit(code);
}
