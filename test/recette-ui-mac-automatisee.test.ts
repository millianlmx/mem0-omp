// Garde de l'ANALYSE de la recette UI Mac (scripts/mac-recette-ui/) : règles de
// défaut (S-7), exceptions (S-8), couverture (S-6), isolation, rapport et
// verdict (S-9). L'analyse est pure : on l'éprouve sur des relevés et des
// parcours SYNTHÉTIQUES construits ici — aucune app, aucune sonde, aucun écran.
// La CLI `recette.ts analyse` est lancée par `spawnSync` sur un dossier jetable.
// Le jeu fictif et les réponses du serveur de fixture (fixture.ts, S-4) sont
// purs aussi : AC-2 les éprouve sans disque ni écoute.
//
// Le script scripts/mac-recette-ui.sh est éprouvé ici sur son refus d'un Space
// plein écran (AC-7), avec des doublures de `uname`, `swiftc` et `swift` ; ses
// relevés réels (intégration) sont prouvés par ses passages sur le Bureau,
// consignés en revue.
//
// PIÈGE (test/criteria.test.ts) : un id qualifié ne vit que dans UN titre et UN
// fichier ; les titres de ce fichier sont des littéraux à guillemets doubles.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  analyser,
  analyserReleve,
  jugerIsolation,
  lireExceptions,
  ligneVerdict,
  rendreRapportMd,
  serialiserRapportJson,
  type Cadre,
  type ConstatIsolation,
  type Isolation,
  type Noeud,
  type Rapport,
  type Releve,
  type SurfaceParcours,
} from "../scripts/mac-recette-ui/analyse.ts";
import { CATALOGUE } from "../scripts/mac-recette-ui/catalogue.ts";
import { JETON_SERVICE, RouteurFixture, depotFictif, jeuFictif, type EntreeJeu, type Requete } from "../scripts/mac-recette-ui/fixture.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "scripts", "mac-recette-ui", "recette.ts");

const jetables: string[] = [];
after(() => {
  for (const d of jetables) fs.rmSync(d, { recursive: true, force: true });
});
function dossierJetable(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "recette-ui-mac-"));
  jetables.push(d);
  return d;
}

// ── Données synthétiques ───────────────────────────────────────────────────

const FENETRE: Cadre = { x: 100, y: 50, largeur: 800, hauteur: 532 };

function noeud(role: string, cadre: Cadre | null, o: Partial<Noeud> = {}): Noeud {
  return {
    role,
    sousRole: null,
    identifiant: null,
    titre: null,
    description: null,
    valeur: null,
    cadre,
    actions: [],
    enfants: [],
    ...o,
  };
}

/** Un cadre relatif au coin haut gauche de la fenêtre. */
const dans = (x: number, y: number, largeur: number, hauteur: number): Cadre => ({
  x: FENETRE.x + x,
  y: FENETRE.y + y,
  largeur,
  hauteur,
});

/** Le relevé SAIN d'une surface : son marqueur, un bouton de 28 × 28, le chrome système. */
function releveSain(id: string, enfants: Noeud[] = []): Releve {
  const marqueur = CATALOGUE.find((s) => s.id === id)?.marqueur ?? id;
  return {
    version: 1,
    surface: id,
    fenetre: { largeur: FENETRE.largeur, hauteur: FENETRE.hauteur },
    racine: noeud("AXWindow", FENETRE, {
      enfants: [
        noeud("AXButton", dans(8, 4, 14, 16), { sousRole: "AXCloseButton" }),
        noeud("AXGroup", dans(0, 52, 800, 480), {
          identifiant: marqueur,
          enfants: [noeud("AXButton", dans(20, 80, 28, 28), { identifiant: `${id}.ok`, titre: "OK", actions: ["AXPress"] })],
        }),
        ...enfants,
      ],
    }),
  };
}

const CONSTAT: ConstatIsolation = {
  instancesUtilisateur: [412],
  premierPlan: { bundle: "com.apple.Terminal", pid: 300 },
  preferences: "9f".repeat(32),
};
const ISOLATION_INTACTE: Isolation = { avant: CONSTAT, apres: CONSTAT, activations: [] };

function parcoursComplet(isolation: unknown = ISOLATION_INTACTE): { version: 1; isolation: unknown; surfaces: SurfaceParcours[] } {
  return {
    version: 1,
    isolation,
    surfaces: CATALOGUE.map((s) => ({
      id: s.id,
      statut: "couverte",
      raison: null,
      fenetre: { largeur: FENETRE.largeur, hauteur: FENETRE.hauteur },
    })),
  };
}

/** Un passage complet et sain ; `remplacer` substitue des relevés par id. */
function passage(remplacer: Record<string, Releve> = {}, exceptions: string | null = '{"version":1,"exceptions":[]}') {
  const releves = new Map<string, unknown>(CATALOGUE.map((s) => [s.id, remplacer[s.id] ?? releveSain(s.id)]));
  return {
    catalogue: CATALOGUE,
    parcours: parcoursComplet() as unknown,
    releves,
    captures: new Set(CATALOGUE.map((s) => s.id)),
    exceptions,
  };
}

const exceptionsJson = (exceptions: unknown[]): string => JSON.stringify({ version: 1, exceptions });

/** Projection d'un signalement sur ce que le rapport doit désigner. */
const designation = (r: Rapport) => r.signalements.map(({ surface, regle, cle }) => ({ surface, regle, cle }));

/** Écrit un passage sur disque au format de la sonde (S-6) pour la CLI. */
function ecrirePassage(sortie: string, parcours: unknown, releves: Releve[]): void {
  fs.mkdirSync(path.join(sortie, "releves"), { recursive: true });
  fs.mkdirSync(path.join(sortie, "captures"), { recursive: true });
  fs.writeFileSync(path.join(sortie, "parcours.json"), JSON.stringify(parcours));
  for (const r of releves) {
    fs.writeFileSync(path.join(sortie, "releves", `${r.surface}.json`), JSON.stringify(r));
    fs.writeFileSync(path.join(sortie, "captures", `${r.surface}.png`), "\x89PNG synthétique");
  }
}

function lancerAnalyse(sortie: string, exceptions: string) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", CLI, "analyse", "--sortie", sortie, "--exceptions", exceptions],
    { encoding: "utf8" },
  );
}

// ── Critères ───────────────────────────────────────────────────────────────

test("recette-ui-mac-automatisee/AC-1 : l'isolation est rompue dès qu'un constat diffère avant/après, et le verdict n'est alors pas vert", () => {
  assert.deepEqual(jugerIsolation(ISOLATION_INTACTE), { rompue: false, constats: [] });
  assert.equal(analyser(passage()).verdict, "vert", "garde : le passage sain est vert");

  const cas: Array<[string, Isolation, string]> = [
    [
      "pid changé",
      { ...ISOLATION_INTACTE, apres: { ...CONSTAT, instancesUtilisateur: [873] } },
      "instance de l'utilisateur changée : 412 → 873",
    ],
    [
      "instance disparue",
      { ...ISOLATION_INTACTE, apres: { ...CONSTAT, instancesUtilisateur: [] } },
      "instance de l'utilisateur changée : 412 → aucune",
    ],
    [
      "empreinte changée",
      { ...ISOLATION_INTACTE, apres: { ...CONSTAT, preferences: "00".repeat(32) } },
      "préférences com.omp.console modifiées pendant la recette",
    ],
    [
      "activation de l'instance de recette",
      { ...ISOLATION_INTACTE, activations: [{ bundle: "com.omp.console.recette", pid: 5150 }] },
      "activation de com.omp.console.recette (pid 5150)",
    ],
    [
      "premier plan changé",
      { ...ISOLATION_INTACTE, apres: { ...CONSTAT, premierPlan: { bundle: "com.apple.Safari", pid: 301 } } },
      "app au premier plan changée : com.apple.Terminal → com.apple.Safari " +
        "(si vous avez changé d'app pendant la recette, relancez-la sans y toucher)",
    ],
  ];
  for (const [nom, isolation, constat] of cas) {
    assert.deepEqual(jugerIsolation(isolation), { rompue: true, constats: [constat] }, nom);
    const entree = passage();
    entree.parcours = parcoursComplet(isolation);
    const rapport = analyser(entree);
    assert.equal(rapport.verdict, "defauts", `${nom} : verdict`);
    assert.deepEqual(rapport.isolation.constats, [constat], `${nom} : constat du rapport`);
    assert.match(ligneVerdict(rapport, "rapport.md"), /, isolation rompue\. Rapport : rapport\.md$/, nom);
    assert.ok(rendreRapportMd(rapport).includes(`Isolation rompue :\n\n- ${constat}\n`), `${nom} : rapport.md`);
  }

  // Plusieurs causes à la fois : un constat par cause, dans l'ordre de S-9.
  const toutes: Isolation = {
    avant: CONSTAT,
    apres: { instancesUtilisateur: [], premierPlan: { bundle: null, pid: 1 }, preferences: "x" },
    activations: [{ bundle: "com.omp.console", pid: 412 }],
  };
  assert.deepEqual(
    jugerIsolation(toutes).constats.map((c) => c.split(" :")[0].split(" (")[0]),
    [
      "instance de l'utilisateur changée",
      "préférences com.omp.console modifiées pendant la recette",
      "activation de com.omp.console",
      "app au premier plan changée",
    ],
  );

  // Constats absents ou mal formés : l'isolation n'est pas prouvée, donc rompue.
  for (const absente of [undefined, null, {}, { avant: CONSTAT, apres: CONSTAT }]) {
    assert.deepEqual(jugerIsolation(absente), { rompue: true, constats: ["constats d'isolation absents"] });
  }
  const sansIsolation = passage();
  sansIsolation.parcours = { version: 1, surfaces: parcoursComplet().surfaces };
  assert.equal(analyser(sansIsolation).verdict, "defauts");
});

test("recette-ui-mac-automatisee/AC-2 : deux analyses des mêmes données rendent un rapport.json identique octet pour octet, sans date, pid ni chemin absolu ; le jeu fictif et ses réponses sont les mêmes à chaque passage, datés d'au moins 2 h, sans chemin hors de R", () => {
  const defectueux: Record<string, Releve> = {
    pipelines: releveSain("pipelines", [noeud("AXButton", dans(10, 500, 16, 16), { titre: "Filtrer" })]),
    "fiche-carte": releveSain("fiche-carte", [
      noeud("AXGroup", dans(0, 0, 40, 40), { identifiant: "kanban.card" }),
      noeud("AXGroup", dans(50, 0, 40, 40), { identifiant: "kanban.card" }),
    ]),
  };
  const exceptions = exceptionsJson([
    { surface: "pipelines", regle: "cible-trop-petite", element: "chemin:AXButton[1]", justification: "défaut connu, à corriger hors de cette feature : bouton Filtrer de 16 pt" },
  ]);

  const premier = passage(defectueux, exceptions);
  const second = passage(defectueux, exceptions);
  second.releves = new Map([...second.releves].reverse());
  second.captures = new Set([...second.captures].reverse());

  const a = serialiserRapportJson(analyser(premier));
  const b = serialiserRapportJson(analyser(second));
  assert.equal(a, b);
  assert.ok(a.endsWith("}\n") && a.includes('\n  "verdict"'), "JSON indenté de 2 espaces, \\n final");
  assert.equal(JSON.parse(a).signalements.length, 2, "garde : le rapport porte bien des signalements");

  const cles: string[] = [];
  const valeurs: string[] = [];
  const parcourir = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(parcourir);
    else if (typeof v === "object" && v !== null) {
      for (const [k, w] of Object.entries(v)) {
        cles.push(k);
        parcourir(w);
      }
    } else if (typeof v === "string") valeurs.push(v);
  };
  parcourir(JSON.parse(a));
  for (const interdite of ["date", "duree", "pid", "chemin", "empreinte", "preferences", "cadre", "fenetre"]) {
    assert.ok(!cles.some((k) => k.toLowerCase().includes(interdite)), `clé « ${interdite} » dans rapport.json`);
  }
  assert.deepEqual(valeurs.filter((v) => v.startsWith("/") || /\b\d{4}-\d{2}-\d{2}T/.test(v) || /[0-9a-f]{64}/.test(v)), []);

  // Jeu fictif (S-4) : même entrée, mêmes octets et mêmes réponses ; aucun chemin
  // hors de R ; toute date au moins 2 h avant le début, pour des libellés relatifs
  // stables pendant le passage.
  const entree: EntreeJeu = {
    racine: "/tmp/omp-console-recette-ui",
    depotReel: "/private/tmp/omp-console-recette-ui/depots/atelier",
    pid: 4242,
    port: 51234,
    debut: Date.UTC(2026, 9, 10, 12),
  };
  const jeu = jeuFictif(entree);
  assert.deepEqual(jeuFictif({ ...entree }), jeu);
  const requetes: Requete[] = [
    { methode: "GET", url: "/health", jetonService: undefined, corps: "" },
    { methode: "GET", url: "/memory/all?agent_id=atelier", jetonService: undefined, corps: "" },
    { methode: "GET", url: "/memory/graph", jetonService: undefined, corps: "" },
    { methode: "POST", url: "/v1/sessions", jetonService: undefined, corps: "{}" },
    { methode: "POST", url: "/v1/sessions", jetonService: JETON_SERVICE, corps: `{"cwd":"${entree.racine}/depots/atelier","purpose":"session"}` },
    { methode: "POST", url: `/v1/projects/${encodeURIComponent(`${entree.racine}/depots/atelier`)}/conduite`, jetonService: JETON_SERVICE, corps: '{"name":"atelier"}' },
    { methode: "GET", url: "/v1/sessions", jetonService: JETON_SERVICE, corps: "" },
    { methode: "GET", url: "/v1/sessions/recette-conduite/events", jetonService: JETON_SERVICE, corps: "" },
  ];
  const rejouer = () => {
    const routeur = new RouteurFixture(entree.racine, entree.debut);
    return requetes.map((q) => routeur.repondre(q));
  };
  const reponses = rejouer();
  assert.deepEqual(rejouer(), reponses);
  assert.deepEqual(reponses.map((r) => (r.type === "json" ? r.statut : "flux")), [200, 200, 200, 401, 200, 200, 200, "flux"]);

  const textes: string[] = [];
  const nombres: Array<[string, number]> = [];
  const relever = (v: unknown, cle: string): void => {
    if (Array.isArray(v)) v.forEach((w) => relever(w, cle));
    else if (typeof v === "object" && v !== null) for (const [k, w] of Object.entries(v)) relever(w, k);
    else if (typeof v === "string") textes.push(v);
    else if (typeof v === "number") nombres.push([cle, v]);
  };
  for (const f of jeu) {
    if (f.chemin.endsWith(".json")) relever(JSON.parse(f.contenu), "");
    else if (f.chemin.endsWith(".jsonl")) for (const l of f.contenu.trimEnd().split("\n")) relever(JSON.parse(l), "");
    else textes.push(f.contenu);
  }
  for (const r of reponses) relever(r.type === "json" ? r.corps : r.trame, "");
  relever(depotFictif(), "");
  assert.deepEqual(textes.filter((t) => t.startsWith("/") && !t.startsWith(`${entree.racine}/`)), [], "chemin hors de R");
  assert.ok(!textes.some((t) => t.includes(os.homedir())), "dossier de l'utilisateur dans le jeu");
  const limite = entree.debut - 2 * 3_600_000;
  const datesIso = textes.filter((t) => /^\d{4}-\d{2}-\d{2}T/.test(t)).map((t) => Date.parse(t));
  const datesMs = nombres.filter(([k]) => /At$/.test(k)).map(([, v]) => v);
  assert.ok(datesIso.length > 0 && datesMs.length > 0, "garde : le jeu porte des dates");
  assert.deepEqual([...datesIso, ...datesMs].filter((d) => d > limite), [], "date à moins de 2 h du début");
});

test("recette-ui-mac-automatisee/AC-3 : 9 sections et 14 feuilles, toutes capturées et relevées, sont couvertes ; un relevé retiré rend sa surface « capture ou relevé manquant »", () => {
  assert.equal(CATALOGUE.filter((s) => s.type === "section").length, 9);
  assert.equal(CATALOGUE.filter((s) => s.type === "feuille").length, 14);
  assert.equal(new Set(CATALOGUE.map((s) => s.id)).size, 23, "ids uniques");
  assert.equal(new Set(CATALOGUE.map((s) => s.marqueur)).size, 23, "marqueurs uniques");

  // La CLI de la sonde lit le catalogue en JSON.
  const catalogue = spawnSync(process.execPath, ["--experimental-strip-types", CLI, "catalogue"], { encoding: "utf8" });
  assert.equal(catalogue.status, 0);
  assert.deepEqual(JSON.parse(catalogue.stdout), CATALOGUE);

  const sortie = dossierJetable();
  const exceptions = path.join(sortie, "exceptions.json");
  fs.writeFileSync(exceptions, exceptionsJson([]));
  ecrirePassage(sortie, parcoursComplet(), CATALOGUE.map((s) => releveSain(s.id)));

  const complet = lancerAnalyse(sortie, exceptions);
  assert.equal(complet.status, 0, complet.stderr);
  const rapportMd = path.join(sortie, "rapport.md");
  assert.equal(
    complet.stdout.trimEnd().split("\n").at(-1),
    `✓ recette Mac : vert — 23 surfaces couvertes, 0 signalement(s) excepté(s). Rapport : ${rapportMd}`,
  );
  const vert = JSON.parse(fs.readFileSync(path.join(sortie, "rapport.json"), "utf8"));
  assert.equal(vert.verdict, "vert");
  assert.deepEqual(
    vert.surfaces,
    CATALOGUE.map((s) => ({ id: s.id, type: s.type, statut: "couverte", raison: null })),
  );
  assert.ok(fs.readFileSync(rapportMd, "utf8").includes("[captures/memoire-lien.png](captures/memoire-lien.png)"));
  assert.deepEqual(fs.readdirSync(sortie).filter((f) => f.includes(".tmp-")), [], "aucun temporaire laissé");

  fs.rmSync(path.join(sortie, "releves", "contrat.json"));
  fs.writeFileSync(path.join(sortie, "captures", "modeles.png"), "");
  const ampute = lancerAnalyse(sortie, exceptions);
  assert.equal(ampute.status, 1);
  const defauts = JSON.parse(fs.readFileSync(path.join(sortie, "rapport.json"), "utf8"));
  assert.equal(defauts.verdict, "defauts");
  assert.deepEqual(
    defauts.surfaces.filter((s: { statut: string }) => s.statut !== "couverte"),
    [
      { id: "contrat", type: "feuille", statut: "non-couverte", raison: "capture ou relevé manquant" },
      { id: "modeles", type: "feuille", statut: "non-couverte", raison: "capture ou relevé manquant" },
    ],
  );
  assert.match(ampute.stdout, /2 surface\(s\) non couverte\(s\)/);

  // Un relevé qui désigne une autre surface que son fichier n'est pas le relevé de celle-ci.
  fs.writeFileSync(path.join(sortie, "releves", "contrat.json"), JSON.stringify(releveSain("modeles")));
  assert.equal(lancerAnalyse(sortie, exceptions).status, 1);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(sortie, "rapport.json"), "utf8")).surfaces.find((s: { id: string }) => s.id === "contrat").raison,
    "capture ou relevé manquant",
  );
});

test("recette-ui-mac-automatisee/AC-4 : un bouton de 18 × 18, un identifiant porté deux fois et un élément hors de la fenêtre donnent trois signalements et le verdict « défauts trouvés »", () => {
  const releve = releveSain("projet", [
    noeud("AXGroup", dans(0, 60, 300, 40), {
      enfants: [noeud("AXButton", dans(10, 70, 18, 18), { description: "Rafraîchir" })],
    }),
    noeud("AXGroup", dans(0, 120, 300, 40), { identifiant: "x.double" }),
    noeud("AXGroup", dans(0, 170, 300, 40), { identifiant: "x.double" }),
    noeud("AXStaticText", dans(FENETRE.largeur + 50, 200, 60, 20), { valeur: "Perdu" }),
    // Témoins à NE PAS signaler : contenu d'une zone défilante hors de la fenêtre
    // (atteignable par défilement), et chrome système trop petit.
    noeud("AXScrollArea", dans(0, 220, 800, 300), {
      enfants: [noeud("AXStaticText", dans(0, 900, 200, 20), { valeur: "Ligne 40" })],
    }),
    noeud("AXButton", dans(30, 4, 14, 16), { sousRole: "AXMinimizeButton" }),
  ]);

  const attendus = [
    { surface: "projet", regle: "cible-trop-petite", cle: "chemin:AXGroup[1]/AXButton[0]" },
    { surface: "projet", regle: "hors-ecran", cle: "chemin:AXStaticText[0]" },
    { surface: "projet", regle: "identifiant-duplique", cle: "id:x.double" },
  ];
  const signalements = analyserReleve(releve);
  assert.deepEqual(
    signalements.map(({ surface, regle, cle }) => ({ surface, regle, cle })).sort((a, b) => (a.regle < b.regle ? -1 : 1)),
    attendus,
  );
  assert.equal(signalements.find((s) => s.regle === "identifiant-duplique")?.occurrences, 2);

  const rapport = analyser(passage({ projet: releve }));
  assert.equal(rapport.verdict, "defauts");
  assert.deepEqual(designation(rapport), attendus);
  assert.deepEqual(
    JSON.parse(serialiserRapportJson(rapport)).signalements,
    [
      { ...attendus[0], role: "AXButton", occurrences: 1, exception: null },
      { ...attendus[1], role: "AXStaticText", occurrences: 1, exception: null },
      { ...attendus[2], role: "AXGroup", occurrences: 2, exception: null },
    ],
  );

  const md = rendreRapportMd(rapport);
  assert.ok(md.startsWith("# Recette Mac — défauts trouvés\n"));
  const nonExceptes = md.slice(md.indexOf("## Signalements non exceptés"), md.indexOf("## Signalements exceptés"));
  for (const fragment of [
    "| projet | cible cliquable de moins de 20 × 20 pt | chemin:AXGroup[1]/AXButton[0] | AXButton | Rafraîchir | x 110, y 120, 18 × 18 |",
    "| projet | élément hors de la zone visible | chemin:AXStaticText[0] | AXStaticText | Perdu |",
    "| projet | identifiant d'accessibilité dupliqué (2 occurrences) | id:x.double | AXGroup | x.double |",
  ]) {
    assert.ok(nonExceptes.includes(fragment), `rapport.md : ${fragment}`);
  }
  assert.equal(
    ligneVerdict(rapport, "r.md"),
    "✗ recette Mac : défauts trouvés — 3 signalement(s) non excepté(s), 0 surface(s) non couverte(s), 0 exception(s) invalide(s). Rapport : r.md",
  );

  // Une clé d'identifiant dupliqué désigne chaque occurrence par son rang (règle portée par l'élément).
  const doublePetit = analyserReleve(
    releveSain("projet", [
      noeud("AXButton", dans(0, 60, 12, 12), { identifiant: "y.double" }),
      noeud("AXButton", dans(0, 90, 12, 12), { identifiant: "y.double" }),
    ]),
  );
  assert.deepEqual(
    doublePetit.map(({ regle, cle }) => `${regle} ${cle}`),
    ["identifiant-duplique id:y.double", "cible-trop-petite id:y.double#1", "cible-trop-petite id:y.double#2"],
  );
});

test("recette-ui-mac-automatisee/AC-5 : une cible de exactement 20 × 20 pt n'est pas signalée, une de 19,99 pt l'est", () => {
  const cibles = [
    noeud("AXButton", dans(0, 60, 20, 20), { identifiant: "pile" }),
    noeud("AXButton", dans(0, 90, 19.999, 20), { identifiant: "arrondi" }),
    noeud("AXButton", dans(0, 120, 19.99, 20), { identifiant: "etroit" }),
    noeud("AXButton", dans(0, 150, 20, 19.99), { identifiant: "bas" }),
    noeud("AXGroup", dans(0, 180, 19, 30), { identifiant: "pressable", actions: ["AXPress"] }),
    noeud("AXGroup", dans(0, 220, 10, 10), { identifiant: "decor" }),
  ];
  assert.deepEqual(
    analyserReleve(releveSain("accueil", cibles)).map((s) => `${s.regle} ${s.cle}`),
    ["cible-trop-petite id:etroit", "cible-trop-petite id:bas", "cible-trop-petite id:pressable"],
  );
  assert.equal(analyser(passage({ accueil: releveSain("accueil", [cibles[0], cibles[1]]) })).verdict, "vert");
});

test("recette-ui-mac-automatisee/AC-6 : une surface que le parcours n'a pas ouverte est nommée non couverte avec sa raison, et le verdict n'est pas vert", () => {
  const entree = passage();
  const parcours = parcoursComplet();
  const modeles = parcours.surfaces.find((s) => s.id === "modeles");
  assert.ok(modeles !== undefined);
  Object.assign(modeles, { statut: "non-couverte", raison: "marqueur models.sheet absent après 20 s", fenetre: null });
  parcours.surfaces = parcours.surfaces.filter((s) => s.id !== "memoire-lien");
  parcours.surfaces.push({ id: "inconnue", statut: "non-couverte", raison: "hors catalogue", fenetre: null });
  entree.parcours = parcours;
  const sansCadre = releveSain("terminal");
  sansCadre.racine.cadre = null;
  entree.releves.set("terminal", sansCadre);

  const rapport = analyser(entree);
  assert.equal(rapport.verdict, "defauts");
  assert.deepEqual(
    rapport.surfaces.filter((s) => s.statut !== "couverte").map(({ id, raison }) => ({ id, raison })),
    [
      { id: "terminal", raison: "cadre de la surface illisible" },
      { id: "modeles", raison: "marqueur models.sheet absent après 20 s" },
      { id: "memoire-lien", raison: "absente du parcours" },
    ],
  );
  assert.equal(rapport.surfaces.length, 23, "une surface hors catalogue est ignorée");

  const md = rendreRapportMd(rapport);
  assert.ok(md.includes("| modeles | feuille | non couverte | marqueur models.sheet absent après 20 s | — | — |"));
  assert.ok(md.includes("| memoire-lien | feuille | non couverte | absente du parcours | — | — |"));
  assert.match(ligneVerdict(rapport, "r.md"), /0 signalement\(s\) non excepté\(s\), 3 surface\(s\) non couverte\(s\),/);

  // Sans parcours du tout : les 23 surfaces sont non couvertes, l'isolation n'est pas prouvée.
  const vide = analyser({ ...passage(), parcours: null });
  assert.equal(vide.verdict, "defauts");
  assert.ok(vide.surfaces.every((s) => s.statut === "non-couverte" && s.raison === "absente du parcours"));
  assert.ok(vide.isolation.rompue);
});

// Faits d'un Mac affiché sur un Space plein écran d'une autre app (S-2, D-4) : la
// fenêtre de Keynote couvre exactement l'écran et AX la dit en plein écran.
const FAITS_PLEIN_ECRAN = {
  version: 1,
  verrouille: false,
  accessibilite: true,
  enregistrementEcran: true,
  premierPlan: { bundle: "com.apple.iWork.Keynote", nom: "Keynote", pid: 4242, pleinEcran: true },
  ecrans: [{ x: 0, y: 0, largeur: 1728, hauteur: 1117 }],
  fenetres: [{ pid: 4242, proprietaire: "Keynote", calque: 0, x: 0, y: 0, largeur: 1728, hauteur: 1117 }],
};

test("recette-ui-mac-automatisee/AC-7 : sur un Space plein écran d'une autre app, le script refuse avant tout lancement, demande de revenir sur le Bureau et sort « non exécutable » (2)", () => {
  // Copie du script et de ses modules : le dossier de sortie et la sonde
  // compilée vivent sous la copie, jamais sous le dépôt.
  const copie = dossierJetable();
  fs.mkdirSync(path.join(copie, "scripts"));
  fs.copyFileSync(path.join(ROOT, "scripts", "mac-recette-ui.sh"), path.join(copie, "scripts", "mac-recette-ui.sh"));
  fs.cpSync(path.join(ROOT, "scripts", "mac-recette-ui"), path.join(copie, "scripts", "mac-recette-ui"), { recursive: true });

  // Doublures en tête de PATH (patron de test/check.test.ts) : `swiftc` écrit à
  // `-o` une sonde qui répond aux faits du plein écran et journalise toute
  // autre sous-commande ; `swift` (construction de l'app) journalise.
  const bin = path.join(copie, "doublures");
  fs.mkdirSync(bin);
  const journal = path.join(copie, "journal.txt");
  fs.writeFileSync(journal, "");
  const faits = path.join(copie, "faits-plein-ecran.json");
  fs.writeFileSync(faits, JSON.stringify(FAITS_PLEIN_ECRAN));
  const doublure = (nom: string, corps: string) => {
    fs.writeFileSync(path.join(bin, nom), `#!/usr/bin/env bash\n${corps}\n`);
    fs.chmodSync(path.join(bin, nom), 0o755);
  };
  doublure("uname", 'echo Darwin');
  doublure("swift", `echo "swift $*" >> "${journal}"`);
  doublure(
    "swiftc",
    [
      `echo "swiftc $*" >> "${journal}"`,
      'sortie=""',
      'while [ "$#" -gt 0 ]; do [ "$1" = -o ] && sortie="$2"; shift; done',
      'cat > "$sortie" <<EOF',
      "#!/usr/bin/env bash",
      `echo "sonde \\$*" >> "${journal}"`,
      `if [ "\\$1" = etat-ecran ]; then cat "${faits}"; exit 0; fi`,
      "exit 0",
      "EOF",
      'chmod +x "$sortie"',
    ].join("\n"),
  );

  const r = spawnSync("bash", [path.join(copie, "scripts", "mac-recette-ui.sh")], {
    cwd: copie,
    encoding: "utf8",
    env: { ...process.env, PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":") },
    timeout: 60_000,
  });
  const sortieTexte = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.status, 2, sortieTexte);

  const lignes = r.stdout.trimEnd().split("\n");
  const derniere = lignes[lignes.length - 1];
  assert.equal(
    derniere,
    "· recette Mac non exécutable : l'écran est sur un Space plein écran (Keynote). Revenez sur le Bureau, puis relancez la recette.",
  );

  const dossierSortie = path.join(copie, "omp-console", "build", "mac-recette-ui", "sortie");
  const rapport = JSON.parse(fs.readFileSync(path.join(dossierSortie, "rapport.json"), "utf8"));
  assert.equal(rapport.verdict, "non-executable");
  assert.match(rapport.raison, /Revenez sur le Bureau/);
  assert.ok(fs.readFileSync(path.join(dossierSortie, "rapport.md"), "utf8").includes("Revenez sur le Bureau"));
  assert.ok(!fs.existsSync(path.join(dossierSortie, "captures")), "aucune capture");
  assert.ok(!fs.existsSync(path.join(dossierSortie, "releves")), "aucun relevé");

  // La sonde a été compilée puis interrogée sur l'écran, et rien d'autre : ni
  // parcours (donc aucune instance de recette), ni construction de l'app.
  const appels = fs.readFileSync(journal, "utf8").trim().split("\n");
  assert.ok(appels.some((l) => l.startsWith("swiftc ")), appels.join("\n"));
  assert.deepEqual(appels.filter((l) => l.startsWith("sonde ")), ["sonde etat-ecran"]);
  assert.ok(!appels.some((l) => l.startsWith("swift ")), appels.join("\n"));
});

test("recette-ui-mac-automatisee/AC-8 : chaque signalement excepté figure au rapport avec sa justification, et le verdict est vert", () => {
  const petit = noeud("AXButton", dans(10, 500, 16, 16), { identifiant: "barre.aide", titre: "Aide" });
  const remplacer: Record<string, Releve> = {};
  for (const s of CATALOGUE.filter((c) => c.type === "section")) remplacer[s.id] = releveSain(s.id, [petit]);
  remplacer.contrat = releveSain("contrat", [noeud("AXStaticText", dans(-40, 60, 80, 20), { valeur: "Besoins" })]);

  const justificationAide = "défaut connu, à corriger hors de cette feature : le bouton Aide de la barre fait 16 × 16 pt";
  const justificationContrat = "faux positif : le titre déborde de 40 pt mais reste lisible dans la capture";
  const exceptions = exceptionsJson([
    { surface: "*", regle: "cible-trop-petite", element: "id:barre.aide", justification: justificationAide },
    { surface: "contrat", regle: "hors-ecran", element: "chemin:AXStaticText[0]", justification: justificationContrat },
    { surface: "modeles", regle: "hors-ecran", element: "id:modeles.absent", justification: "faux positif : plus produit" },
  ]);

  const rapport = analyser(passage(remplacer, exceptions));
  assert.equal(rapport.verdict, "vert");
  const json = JSON.parse(serialiserRapportJson(rapport));
  assert.equal(json.signalements.length, 10);
  assert.ok(json.signalements.every((s: { exception: string | null }) => s.exception !== null));
  assert.deepEqual(json.signalements.at(-1), {
    surface: "contrat",
    regle: "hors-ecran",
    cle: "chemin:AXStaticText[0]",
    role: "AXStaticText",
    occurrences: 1,
    exception: justificationContrat,
  });
  assert.equal(json.signalements[0].exception, justificationAide);
  assert.deepEqual(json.exceptionsSansObjet, [{ surface: "modeles", regle: "hors-ecran", element: "id:modeles.absent" }]);
  assert.deepEqual(json.exceptionsInvalides, []);

  const md = rendreRapportMd(rapport);
  assert.ok(md.startsWith("# Recette Mac — vert\n"));
  const exceptes = md.slice(md.indexOf("## Signalements exceptés"), md.indexOf("## Exceptions invalides"));
  assert.ok(exceptes.includes(`| contrat | élément hors de la zone visible | chemin:AXStaticText[0] | AXStaticText | Besoins | x 60, y 110, 80 × 20 | ${justificationContrat} |`));
  assert.ok(exceptes.includes(`| accueil | cible cliquable de moins de 20 × 20 pt | id:barre.aide | AXButton | Aide | x 110, y 550, 16 × 16 | ${justificationAide} |`));
  assert.ok(md.includes("## Signalements non exceptés\n\nAucun.\n"));
  assert.ok(md.includes("| modeles | hors-ecran | id:modeles.absent |"));
  assert.equal(
    ligneVerdict(rapport, "r.md"),
    "✓ recette Mac : vert — 23 surfaces couvertes, 10 signalement(s) excepté(s). Rapport : r.md",
  );

  // Le fichier LIVRÉ (S-10) : lisible, toutes ses entrées valides, chaque
  // justification sous l'une des deux formes admises.
  const livre = lireExceptions(fs.readFileSync(path.join(ROOT, "scripts", "mac-recette-ui", "exceptions.json"), "utf8"));
  assert.deepEqual(livre.invalides, []);
  for (const { entree } of livre.valides) {
    assert.match(entree.justification, /^(faux positif : |défaut connu, à corriger hors de cette feature : )\S/, JSON.stringify(entree));
  }
});

test("recette-ui-mac-automatisee/AC-9 : une exception invalide ou un signalement sans exception est désigné au rapport, et le verdict n'est pas vert", () => {
  const remplacer = { memoire: releveSain("memoire", [noeud("AXButton", dans(10, 500, 16, 16), { identifiant: "graphe.zoom" })]) };
  const cible = { surface: "memoire", regle: "cible-trop-petite", element: "id:graphe.zoom" };

  // Exception sans justification : invalide, n'excepte rien.
  for (const justification of [undefined, "", "   ", 42]) {
    const rapport = analyser(passage(remplacer, exceptionsJson([{ ...cible, justification }])));
    assert.equal(rapport.verdict, "defauts");
    assert.deepEqual(rapport.exceptionsInvalides, [{ index: 0, raison: "justification manquante" }]);
    assert.equal(rapport.signalements[0].exception, null, "une entrée invalide n'excepte rien");
    assert.ok(rendreRapportMd(rapport).includes("| n°0 | justification manquante |"));
  }

  // Signalement non couvert par une exception : listé non excepté.
  const restant = analyser(passage(remplacer, exceptionsJson([])));
  assert.equal(restant.verdict, "defauts");
  assert.deepEqual(designation(restant), [{ surface: "memoire", regle: "cible-trop-petite", cle: "id:graphe.zoom" }]);
  assert.equal(restant.signalements[0].exception, null);
  const nonExceptes = rendreRapportMd(restant).split("## Signalements non exceptés")[1].split("## Signalements exceptés")[0];
  assert.ok(nonExceptes.includes("| memoire | cible cliquable de moins de 20 × 20 pt | id:graphe.zoom | AXButton |"));
  assert.match(ligneVerdict(restant, "r.md"), /— 1 signalement\(s\) non excepté\(s\), 0 surface\(s\) non couverte\(s\), 0 exception\(s\) invalide\(s\)\./);

  // Chaque raison d'invalidité, dans l'ordre de S-8 ; la première trouvée l'emporte.
  const justification = "faux positif : témoin";
  const melange = analyser(
    passage(
      remplacer,
      exceptionsJson([
        { ...cible, justification },
        { ...cible, surface: "reglages", justification: "" },
        { ...cible, regle: "trop-petit", justification },
        { ...cible, element: "", justification },
        { surface: "*", regle: "hors-ecran", justification },
        { ...cible, justification: "autre justification" },
        "pas un objet",
      ]),
    ),
  );
  assert.equal(melange.verdict, "defauts");
  assert.deepEqual(melange.exceptionsInvalides, [
    { index: 1, raison: "surface inconnue" },
    { index: 2, raison: "règle inconnue" },
    { index: 3, raison: "élément manquant" },
    { index: 4, raison: "élément manquant" },
    { index: 5, raison: "doublon de l'exception n°0" },
    { index: 6, raison: "surface inconnue" },
  ]);
  assert.equal(melange.signalements[0].exception, justification, "l'entrée valide excepte toujours");
  assert.match(ligneVerdict(melange, "r.md"), /— 0 signalement\(s\) non excepté\(s\), 0 surface\(s\) non couverte\(s\), 6 exception\(s\) invalide\(s\)\./);

  // Fichier illisible : aucune exception appliquée, un défaut global d'index null.
  for (const [texte, raison] of [
    [null, "fichier absent"],
    ["{", "JSON invalide"],
    ['{"version":2,"exceptions":[]}', "version différente de 1"],
    ['{"version":1,"exceptions":{}}', "« exceptions » n'est pas un tableau"],
  ] as const) {
    const illisible = analyser(passage({}, texte));
    assert.equal(illisible.verdict, "defauts", raison);
    assert.deepEqual(illisible.exceptionsInvalides, [{ index: null, raison: `fichier d'exceptions illisible : ${raison}` }]);
    assert.ok(rendreRapportMd(illisible).includes(`| fichier | fichier d'exceptions illisible : ${raison} |`));
  }
});
