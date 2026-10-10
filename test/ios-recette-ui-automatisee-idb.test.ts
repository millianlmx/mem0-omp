// Garde de l'ANALYSEUR de la recette idb (`scripts/ios-recette-ui-analyse.py`) :
// règles de défaut, exceptions, rapport et verdict. L'analyseur est pur, donc on
// l'éprouve sur 24 relevés SYNTHÉTIQUES (JSON écrits ici, PNG unis 1206 × 2622
// écrits par zlib) lancés par `spawnSync` — aucun simulateur, aucun idb, aucun Pillow.
//
// Le script `scripts/ios-recette-ui.sh` (relevés réels, intégration) est prouvé
// par ses passages sur simulateur, pas par ce fichier.
//
// PIÈGE (test/criteria.test.ts) : un id qualifié ne vit que dans UN titre et UN
// fichier ; les titres de ce fichier sont des littéraux à guillemets doubles.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const ANALYSEUR = path.join(ROOT, "scripts", "ios-recette-ui-analyse.py");
const EXCEPTIONS_VERSIONNEES = path.join(ROOT, "scripts", "ios-recette-ui-exceptions.json");

const SURFACES = ["home", "kanban", "project", "session", "sessions", "memory", "stats", "kanban-fiche"];
const CONFIGS: Array<[string, string]> = [
  ["clair", "defaut"],
  ["sombre", "defaut"],
  ["clair", "ax-xl"],
];
const PX_L = 1206;
const PX_H = 2622;
const ECHELLE = 3;

type Frame = { x: number; y: number; width: number; height: number };
type Element = {
  type: string;
  AXLabel?: string | null;
  AXUniqueId?: string | null;
  frame?: Frame;
  [k: string]: unknown;
};
/** Bande peinte dans la colonne de pixels du bord : [y0, y1) en points. */
type Bande = { cote: "gauche" | "droite"; y0: number; y1: number; couleur: [number, number, number] };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ios-recette-ui-test-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let compteur = 0;
const frais = (nom: string): string => {
  const d = path.join(TMP, `${nom}-${++compteur}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

const FOND = { clair: [255, 255, 255], sombre: [0, 0, 0] } as Record<string, number[]>;

/** Écrit un PNG RGB 1206 × 2622 uni (fond de l'apparence) avec des bandes de bord. */
function peindre(fichier: string, apparence: string, bandes: Bande[]): void {
  const fond = FOND[apparence];
  const pas = PX_L * 3;
  const brut = Buffer.alloc((pas + 1) * PX_H);
  for (let y = 0; y < PX_H; y++) {
    const ligne = y * (pas + 1) + 1; // l'octet de filtre (0 : aucun) précède chaque ligne
    for (let x = 0; x < PX_L; x++) brut.set(fond, ligne + x * 3);
  }
  for (const b of bandes) {
    const x = b.cote === "gauche" ? 0 : PX_L - 1;
    for (let y = Math.round(b.y0 * ECHELLE); y < Math.round(b.y1 * ECHELLE); y++) {
      brut.set(b.couleur, y * (pas + 1) + 1 + x * 3);
    }
  }
  const bloc = (genre: string, corps: Buffer): Buffer => {
    const tete = Buffer.alloc(8);
    tete.writeUInt32BE(corps.length, 0);
    tete.write(genre, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([tete.subarray(4), corps])), 0);
    return Buffer.concat([tete, corps, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(PX_L, 0);
  ihdr.writeUInt32BE(PX_H, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB, deflate, filtrage standard, non entrelacé
  fs.writeFileSync(
    fichier,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      bloc("IHDR", ihdr),
      bloc("IDAT", zlib.deflateSync(brut)),
      bloc("IEND", Buffer.alloc(0)),
    ]),
  );
}

const unis: Record<string, string> = {};
function pngUni(apparence: string): string {
  if (!unis[apparence]) {
    unis[apparence] = path.join(TMP, `uni-${apparence}.png`);
    peindre(unis[apparence], apparence, []);
  }
  return unis[apparence];
}

const cadre = (x: number, y: number, width: number, height: number): Frame => ({ x, y, width, height });

/** Marqueur propre de chaque surface : un élément inoffensif (StaticText, 44 pt de haut). */
function marqueurPropre(surface: string): Element[] {
  const f = cadre(20, 120, 200, 44);
  switch (surface) {
    case "home":
      return [{ type: "StaticText", AXUniqueId: "ios.home.allPipelines", frame: f }];
    case "kanban":
      return [
        { type: "StaticText", AXUniqueId: "pipelines.list", frame: f },
        { type: "StaticText", AXLabel: "Non appairé", frame: cadre(20, 200, 200, 44) },
      ];
    case "project":
      return [{ type: "Heading", AXLabel: "Projet", frame: f }];
    case "session":
      return [{ type: "StaticText", AXUniqueId: "ios.sessionomp.status", frame: f }];
    case "sessions":
      return [{ type: "StaticText", AXLabel: "parity-session-1 · ouverte", frame: f }];
    case "memory":
      return [{ type: "StaticText", AXUniqueId: "ios.memoire.mode", frame: f }];
    case "stats":
      return [{ type: "Heading", AXLabel: "Statistiques", frame: f }];
    default:
      return [{ type: "StaticText", AXUniqueId: "pipelines.card.sheet.root", frame: f }];
  }
}

const application = (): Element => ({
  type: "Application",
  AXLabel: "OMP Console",
  frame: cadre(0, 0, 402, 874),
});

type Personnalisation = {
  /** Éléments en plus (après le marqueur), par surface/apparence/taille. */
  elements?: (surface: string, apparence: string, taille: string) => Element[];
  /** Remplace les éléments du marqueur propre. */
  marqueur?: (surface: string, apparence: string, taille: string) => Element[] | undefined;
  bandes?: (surface: string, apparence: string, taille: string) => Bande[];
  /** Surfaces/configurations dont on supprime un fichier. */
  sans?: string[];
};

/** Dossier de 24 relevés synthétiques propres, modifiables par `perso`. */
function releves(perso: Personnalisation = {}): string {
  const dossier = frais("releves");
  for (const [apparence, taille] of CONFIGS) {
    for (const surface of SURFACES) {
      const nom = `${surface}-${apparence}-${taille}`;
      const base = perso.marqueur?.(surface, apparence, taille) ?? marqueurPropre(surface);
      const arbre = [application(), ...base, ...(perso.elements?.(surface, apparence, taille) ?? [])];
      fs.writeFileSync(path.join(dossier, nom + ".json"), JSON.stringify(arbre));
      const bandes = perso.bandes?.(surface, apparence, taille) ?? [];
      if (bandes.length === 0) fs.copyFileSync(pngUni(apparence), path.join(dossier, nom + ".png"));
      else peindre(path.join(dossier, nom + ".png"), apparence, bandes);
    }
  }
  for (const f of perso.sans ?? []) fs.rmSync(path.join(dossier, f));
  return dossier;
}

type Exception = Record<string, unknown>;
const exception = (surcharge: Exception = {}): Exception => ({
  surface: "home",
  apparence: "clair",
  taille: "defaut",
  regle: "cible-44",
  source: "ax",
  element: "id:ios.home.fixture",
  justification: "bouton de fixture sans correctif",
  ...surcharge,
});

function ecrireExceptions(contenu: unknown): string {
  const f = path.join(frais("exceptions"), "exceptions.json");
  fs.writeFileSync(f, typeof contenu === "string" ? contenu : JSON.stringify(contenu));
  return f;
}

type Passage = { status: number | null; stdout: string; stderr: string; lignes: string[]; rapport: string };

function analyser(dossier: string, exceptions: unknown = []): Passage {
  const fichierExceptions = ecrireExceptions(exceptions);
  const rapport = path.join(frais("rapport"), "rapport.txt");
  const r = spawnSync(
    "python3",
    [ANALYSEUR, "analyser", "--releves", dossier, "--exceptions", fichierExceptions, "--rapport", rapport],
    { encoding: "utf8" },
  );
  const texte = fs.existsSync(rapport) ? fs.readFileSync(rapport, "utf8") : "";
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    lignes: texte === "" ? [] : texte.replace(/\n$/, "").split("\n"),
    rapport: texte,
  };
}

function valider(exceptions: unknown): { status: number | null; stderr: string; stdout: string } {
  const f = ecrireExceptions(exceptions);
  const r = spawnSync("python3", [ANALYSEUR, "analyser", "--exceptions", f, "--valider-seulement"], {
    encoding: "utf8",
  });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout };
}

const bouton = (id: string | null, f: Frame, extra: Partial<Element> = {}): Element => ({
  type: "Button",
  AXUniqueId: id,
  frame: f,
  ...extra,
});

/** Ajoute des éléments à UNE configuration d'UNE surface seulement. */
const sur =
  (cible: string, apparence: string, taille: string, elements: Element[]) =>
  (surface: string, a: string, t: string): Element[] =>
    surface === cible && a === apparence && t === taille ? elements : [];

const CTX = (s: string, a = "clair", t = "defaut") => `surface=${s}\tapparence=${a}\ttaille=${t}`;

// ── Règles ────────────────────────────────────────────────────────────────────

test("ios-recette-ui-automatisee-idb/AC-5 : un bouton de 20 pt sort en 1 et sa ligne nomme surface, apparence, taille, règle, élément et cadre", () => {
  const p = analyser(
    releves({
      marqueur: (s, a, t) =>
        s === "home" && a === "clair" && t === "defaut" ? [bouton("ios.home.allPipelines", cadre(289.7, 136.7, 96.3, 20.3))] : undefined,
    }),
  );
  assert.equal(p.status, 1, p.stderr);
  assert.deepEqual(p.lignes, [
    "SIGNALÉ\tsurface=home\tapparence=clair\ttaille=defaut\tregle=cible-44\tsource=ax\telement=id:ios.home.allPipelines\tcadre=289.7,136.7,96.3x20.3",
  ]);
  assert.match(p.stdout, /^rapport : .*rapport\.txt$/m);
  assert.match(p.stdout, /^1 signalé\(s\), 0 excepté\(s\)$/m);
});

test("ios-recette-ui-automatisee-idb/AC-3 : « Tout afficher » et « Lire le contrat » à 20,3 pt de haut sont signalés cible-44", () => {
  const p = analyser(
    releves({
      marqueur: (s, a, t) =>
        s === "home" && a === "clair" && t === "defaut"
          ? [
              bouton("ios.home.allPipelines", cadre(289.7, 136.7, 96.3, 20.3), { AXLabel: "Tout afficher" }),
              bouton("ios.home.attention.f1.contract", cadre(40, 300, 104.7, 20.3), { AXLabel: "Lire le contrat" }),
            ]
          : undefined,
    }),
  );
  assert.equal(p.status, 1);
  const lignes = p.lignes.filter((l) => l.includes("regle=cible-44"));
  assert.equal(lignes.length, 2);
  for (const [id, h] of [
    ["ios.home.allPipelines", "20.3"],
    ["ios.home.attention.f1.contract", "20.3"],
  ]) {
    const l = lignes.find((x) => x.includes(`element=id:${id}\t`));
    assert.ok(l, `ligne pour ${id}`);
    assert.ok(l.startsWith(`SIGNALÉ\t${CTX("home")}\t`), l);
    assert.ok(l.endsWith(`x${h}`), `hauteur ${h} dans ${l}`);
  }
});

test("bornes cible-44 : 44,0 x 44,0 passe, 43,9 est signalé, un StaticText de 20 pt passe", () => {
  const p = analyser(
    releves({
      elements: sur("home", "clair", "defaut", [
        bouton("ok.exact", cadre(20, 300, 44, 44)),
        bouton("ko.hauteur", cadre(20, 360, 60, 43.9)),
        bouton("ko.largeur", cadre(20, 420, 43.9, 60)),
        { type: "StaticText", AXUniqueId: "texte.court", frame: cadre(20, 500, 100, 20) },
        { type: "TextField", AXUniqueId: "champ.court", frame: cadre(20, 540, 100, 30) },
      ]),
    }),
  );
  assert.equal(p.status, 1);
  const els = p.lignes.map((l) => l.split("\t")[6]);
  assert.deepEqual(els, ["element=id:ko.hauteur", "element=id:ko.largeur", "element=id:champ.court"]);
});

test("ios-recette-ui-automatisee-idb/AC-4 : deux éléments portant pipelines.card.sheet.title donnent deux lignes id-duplique sur la feuille", () => {
  const titre = (y: number): Element => ({
    type: "StaticText",
    AXUniqueId: "pipelines.card.sheet.title",
    AXLabel: "Reprendre le lot",
    frame: cadre(20, y, 300, 44),
  });
  const p = analyser(releves({ elements: sur("kanban-fiche", "clair", "defaut", [titre(180), titre(240)]) }));
  assert.equal(p.status, 1);
  assert.equal(p.lignes.length, 2);
  for (const l of p.lignes) {
    assert.ok(l.startsWith(`SIGNALÉ\t${CTX("kanban-fiche")}\tregle=id-duplique\tsource=ax\telement=id:pipelines.card.sheet.title\t`), l);
  }
  assert.ok(p.lignes[0].endsWith("cadre=20.0,180.0,300.0x44.0"));
  assert.ok(p.lignes[1].endsWith("cadre=20.0,240.0,300.0x44.0"));
});

test("id-duplique : un identifiant vide ou null n'est jamais un doublon", () => {
  const p = analyser(
    releves({
      elements: sur("home", "clair", "defaut", [
        { type: "StaticText", AXUniqueId: "", frame: cadre(20, 300, 100, 44) },
        { type: "StaticText", AXUniqueId: "", frame: cadre(20, 360, 100, 44) },
        { type: "StaticText", AXUniqueId: null, frame: cadre(20, 420, 100, 44) },
        { type: "StaticText", frame: cadre(20, 480, 100, 44) },
        { type: "StaticText", AXUniqueId: "unique", frame: cadre(20, 540, 100, 44) },
      ]),
    }),
  );
  assert.equal(p.status, 0, p.lignes.join("\n"));
  assert.deepEqual(p.lignes, []);
});

test("bord ax : x = 0 signalé, x = 0,6 non signalé, bord droit signalé", () => {
  const p = analyser(
    releves({
      elements: sur("stats", "clair", "defaut", [
        { type: "Group", AXUniqueId: "colle.gauche", frame: cadre(0, 300, 100, 44) },
        { type: "Group", AXUniqueId: "libre.gauche", frame: cadre(0.6, 360, 100, 44) },
        { type: "Group", AXUniqueId: "colle.droite", frame: cadre(300, 420, 102, 44) },
        { type: "Group", AXUniqueId: "libre.droite", frame: cadre(300, 480, 101.4, 44) },
        { type: "Group", AXUniqueId: "sans.taille", frame: cadre(0, 540, 0, 0) },
      ]),
    }),
  );
  assert.equal(p.status, 1);
  assert.deepEqual(
    p.lignes.map((l) => l.split("\t").slice(1, 7).join("|")),
    [
      "surface=stats|apparence=clair|taille=defaut|regle=bord|source=ax|element=id:colle.gauche",
      "surface=stats|apparence=clair|taille=defaut|regle=bord|source=ax|element=id:colle.droite",
    ],
  );
});

test("ios-recette-ui-automatisee-idb/AC-2 : une bande de bord de 44 pt sur Pipelines, Sessions et Mémoire est signalée avec l'élément le plus à gauche", () => {
  const conteneur = (id: string): Element => ({ type: "Group", AXUniqueId: id, frame: cadre(16, 100, 370, 700) });
  const ecrans: Record<string, string> = {
    kanban: "pipelines.screen",
    sessions: "ios.sessions.screen",
    memory: "ios.memoire.screen",
  };
  const p = analyser(
    releves({
      elements: (s, a, t) => (a === "clair" && t === "defaut" && ecrans[s] ? [conteneur(ecrans[s])] : []),
      bandes: (s, a, t) =>
        a === "clair" && t === "defaut" && ecrans[s]
          ? [{ cote: "gauche", y0: 100, y1: 744, couleur: [242, 242, 247] }]
          : [],
    }),
  );
  assert.equal(p.status, 1, p.stderr);
  const bord = p.lignes.filter((l) => l.includes("regle=bord\tsource=capture"));
  assert.deepEqual(
    bord.map((l) => l.split("\t").slice(1, 2).concat(l.split("\t").slice(6, 8)).join("|")),
    [
      "surface=kanban|element=id:pipelines.screen|cadre=0.0,100.0,0.3x644.0",
      "surface=sessions|element=id:ios.sessions.screen|cadre=0.0,100.0,0.3x644.0",
      "surface=memory|element=id:ios.memoire.screen|cadre=0.0,100.0,0.3x644.0",
    ],
  );
  assert.equal(p.lignes.length, 3, "aucun autre signalement");
});

test("bord capture : 44 pt signalé, 43 pt non, écart de 6 non, côté droit en x = W - 1/échelle, aucune analyse sur la feuille", () => {
  const bandes = (parSurface: Record<string, Bande[]>) => (s: string, a: string, t: string) =>
    a === "clair" && t === "defaut" ? (parSurface[s] ?? []) : [];
  const p = analyser(
    releves({
      elements: sur("project", "clair", "defaut", [
        { type: "Group", AXUniqueId: "proche", frame: cadre(10, 100, 100, 100) },
        { type: "Group", AXUniqueId: "loin", frame: cadre(50, 100, 100, 100) },
        { type: "Group", AXUniqueId: "pleine.largeur", frame: cadre(0, 100, 402, 100) },
      ]),
      bandes: bandes({
        project: [
          { cote: "gauche", y0: 100, y1: 144, couleur: [220, 220, 225] },
          { cote: "droite", y0: 300, y1: 344, couleur: [220, 220, 225] },
        ],
        session: [{ cote: "gauche", y0: 100, y1: 143, couleur: [220, 220, 225] }],
        stats: [{ cote: "gauche", y0: 100, y1: 400, couleur: [249, 249, 249] }],
        memory: [{ cote: "gauche", y0: 100, y1: 400, couleur: [248, 248, 248] }],
        "kanban-fiche": [{ cote: "gauche", y0: 100, y1: 500, couleur: [204, 204, 204] }],
      }),
    }),
  );
  assert.equal(p.status, 1, p.stderr);
  const capture = p.lignes.filter((l) => l.includes("source=capture"));
  const resume = capture.map((l) => {
    const c = l.split("\t");
    return [c[1], c[6], c[7]].join("|");
  });
  assert.deepEqual(resume, [
    "surface=project|element=id:proche|cadre=0.0,100.0,0.3x44.0",
    "surface=project|element=type:capture|cadre=401.7,300.0,0.3x44.0",
    "surface=memory|element=id:ios.memoire.mode|cadre=0.0,100.0,0.3x300.0",
  ]);
});

test("ordre du rapport : surfaces, puis configurations, puis règles, puis ordre de l'arbre", () => {
  const p = analyser(
    releves({
      elements: (s, a, t) => {
        if (s === "stats" && a === "clair" && t === "ax-xl") return [bouton("stats.court", cadre(20, 300, 30, 30))];
        if (s === "home" && a === "sombre")
          return [
            { type: "Group", AXUniqueId: "colle", frame: cadre(0, 300, 50, 50) },
            bouton("zz.court", cadre(20, 400, 30, 30)),
            bouton("aa.court", cadre(20, 460, 30, 30)),
          ];
        if (s === "home" && a === "clair" && t === "defaut") return [bouton("home.clair", cadre(20, 400, 30, 30))];
        return [];
      },
    }),
  );
  assert.deepEqual(
    p.lignes.map((l) => l.split("\t").slice(1, 7).map((c) => c.split("=")[1]).join("|").replace(/\|(ax)\|/, "|$1|")),
    [
      "home|clair|defaut|cible-44|ax|id:home.clair",
      "home|sombre|defaut|cible-44|ax|id:zz.court",
      "home|sombre|defaut|cible-44|ax|id:aa.court",
      "home|sombre|defaut|bord|ax|id:colle",
      "stats|clair|ax-xl|cible-44|ax|id:stats.court",
    ],
  );
});

test("des relevés propres sortent en 0 avec un rapport vide", () => {
  const p = analyser(releves());
  assert.equal(p.status, 0, p.stderr);
  assert.equal(p.rapport, "");
  assert.match(p.stdout, /^0 signalé\(s\), 0 excepté\(s\)$/m);
});

// ── Exceptions et verdict ─────────────────────────────────────────────────────

const avecBoutonFixture = releves({
  elements: sur("home", "clair", "defaut", [bouton("ios.home.fixture", cadre(20, 300, 100, 30))]),
});

test("ios-recette-ui-automatisee-idb/AC-7 : retirer l'exception qui couvre un signalement émis fait sortir en 1 et le rapport nomme ce signalement", () => {
  const avec = analyser(avecBoutonFixture, [exception()]);
  assert.equal(avec.status, 0, avec.stderr);
  assert.equal(avec.lignes.length, 1);
  assert.equal(
    avec.lignes[0],
    `EXCEPTÉ\t${CTX("home")}\tregle=cible-44\tsource=ax\telement=id:ios.home.fixture\tcadre=20.0,300.0,100.0x30.0\texception=1\tjustification=bouton de fixture sans correctif`,
  );
  assert.match(avec.stdout, /^0 signalé\(s\), 1 excepté\(s\)$/m);

  const sans = analyser(avecBoutonFixture, []);
  assert.equal(sans.status, 1);
  assert.deepEqual(sans.lignes, [
    `SIGNALÉ\t${CTX("home")}\tregle=cible-44\tsource=ax\telement=id:ios.home.fixture\tcadre=20.0,300.0,100.0x30.0`,
  ]);
});

test("correspondance des exceptions : la première entrée qui vérifie tout gagne, * élargit, l'élément est strict", () => {
  const p = analyser(avecBoutonFixture, [
    exception({ element: "id:ios.home.fixture ", justification: "espace en trop : jamais" }),
    exception({ surface: "*", apparence: "*", taille: "*", justification: "première qui correspond" }),
    exception({ justification: "seconde, jamais atteinte" }),
    exception({ regle: "bord", element: "id:ios.home.fixture", justification: "autre règle" }),
  ]);
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.lignes[0], /\texception=2\tjustification=première qui correspond$/);
  assert.deepEqual(
    p.stdout.split("\n").filter((l) => l.startsWith("exception inutilisée")),
    ["exception inutilisée : 1", "exception inutilisée : 3", "exception inutilisée : 4"],
  );
});

test("une exception inutilisée est un avertissement : le code reste 0", () => {
  const p = analyser(releves(), [exception()]);
  assert.equal(p.status, 0);
  assert.match(p.stdout, /^exception inutilisée : 1$/m);
});

test("exceptions : justification vide ou absente, clé inconnue, source capture hors bord et valeur hors énumération font sortir en 2", () => {
  const cas: Array<[Exception, RegExp]> = [
    [exception({ justification: "  \t" }), /^exception 1 invalide : justification /],
    [(({ justification, ...reste }) => reste)(exception()), /^exception 1 invalide : justification est absente/],
    [exception({ commentaire: "x" }), /^exception 1 invalide : commentaire n'est pas une clé permise/],
    [exception({ source: "capture" }), /^exception 1 invalide : source /],
    [exception({ regle: "contraste" }), /^exception 1 invalide : regle /],
    [exception({ surface: "ipad" }), /^exception 1 invalide : surface /],
    [exception({ element: "id:" }), /^exception 1 invalide : element /],
    [exception({ element: "Tout afficher" }), /^exception 1 invalide : element /],
  ];
  for (const [entree, attendu] of cas) {
    const v = valider([entree]);
    assert.equal(v.status, 2, JSON.stringify(entree));
    assert.match(v.stderr, attendu);
    assert.equal(v.stdout, "");
    // la même entrée fait aussi sortir l'analyse complète en 2, avant tout relevé
    assert.equal(analyser(releves({ sans: ["home-clair-defaut.png"] }), [entree]).status, 2);
  }
  const numero = valider([exception(), exception({ justification: "" })]);
  assert.match(numero.stderr, /^exception 2 invalide : justification /);
});

test("exceptions : fichier absent, JSON invalide et valeur non tableau font sortir en 2 avec le chemin", () => {
  for (const contenu of ["{pas du json", "{}"]) {
    const f = ecrireExceptions(contenu);
    const r = spawnSync("python3", [ANALYSEUR, "analyser", "--exceptions", f, "--valider-seulement"], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.ok(r.stderr.startsWith(`exceptions invalides : ${f} : `), r.stderr);
  }
  const absent = path.join(TMP, "nexiste-pas.json");
  const r = spawnSync("python3", [ANALYSEUR, "analyser", "--exceptions", absent, "--valider-seulement"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.ok(r.stderr.startsWith(`exceptions invalides : ${absent} : `), r.stderr);
});

test("exceptions protégées : une par famille d'audit sort en 2 avec le message interdite", () => {
  const protegees: Exception[] = [
    exception({ element: "id:ios.home.allPipelines" }),
    exception({ element: "id:ios.projet.start" }),
    exception({ element: "libellé:Tout afficher" }),
    exception({ element: "libellé:Lire le contrat" }),
    exception({ element: "libellé:Piloter un projet…" }),
    exception({ element: "id:ios.home.attention.abc.contract" }),
    exception({ regle: "id-duplique", element: "id:pipelines.card.sheet.title", surface: "kanban-fiche" }),
    exception({ regle: "bord", source: "capture", surface: "kanban", element: "id:pipelines.screen" }),
    exception({ regle: "bord", source: "capture", surface: "sessions", element: "id:ios.sessions.screen" }),
    exception({ regle: "bord", source: "capture", surface: "memory", element: "id:ios.memoire.screen" }),
    exception({ regle: "bord", source: "capture", surface: "*", element: "type:capture" }),
  ];
  for (const entree of protegees) {
    const v = valider([exception(), entree]);
    assert.equal(v.status, 2, JSON.stringify(entree));
    assert.equal(
      v.stderr.trim(),
      "exception 2 interdite : elle masquerait un défaut visé par l'audit (AC-2, AC-3 ou AC-4)",
    );
  }
  // les voisins légitimes restent permis
  for (const permise of [
    exception({ regle: "bord", source: "capture", surface: "home", element: "id:ios.home.root" }),
    exception({ regle: "bord", source: "ax", surface: "kanban", element: "id:pipelines.screen" }),
    exception({ regle: "cible-44", element: "id:ios.home.attention.abc.open" }),
    exception({ regle: "id-duplique", element: "id:autre.titre" }),
  ]) {
    assert.equal(valider([permise]).status, 0, JSON.stringify(permise));
  }
});

test("la liste d'exceptions versionnée est valide", () => {
  const r = spawnSync("python3", [ANALYSEUR, "analyser", "--exceptions", EXCEPTIONS_VERSIONNEES, "--valider-seulement"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
});

// ── Relevés incomplets ou faux ────────────────────────────────────────────────

test("relevés : une paire manquante, un JSON illisible, un marqueur absent ou un kanban sans « Non appairé » font sortir en 2", () => {
  const manquante = analyser(releves({ sans: ["memory-sombre-defaut.png"] }));
  assert.equal(manquante.status, 2);
  assert.equal(manquante.stderr.trim(), "relevé manquant : memory-sombre-defaut.png");

  const dossier = releves();
  fs.writeFileSync(path.join(dossier, "stats-clair-ax-xl.json"), "[{pas du json");
  const illisible = analyser(dossier);
  assert.equal(illisible.status, 2);
  assert.equal(illisible.stderr.trim(), "relevé invalide : stats-clair-ax-xl.json");

  const sansApp = releves();
  fs.writeFileSync(path.join(sansApp, "home-clair-defaut.json"), JSON.stringify([{ type: "Button", frame: cadre(0, 0, 10, 10) }]));
  assert.equal(analyser(sansApp).stderr.trim(), "relevé invalide : home-clair-defaut.json");

  const racine = analyser(
    releves({ marqueur: (s, a, t) => (s === "project" && a === "sombre" ? [{ type: "StaticText", AXUniqueId: "ios.section.project", frame: cadre(20, 100, 100, 44) }] : undefined) }),
  );
  assert.equal(racine.status, 2);
  assert.equal(racine.stderr.trim(), "surface non vérifiée : project sombre defaut (marqueur absent)");

  const appaire = analyser(
    releves({ marqueur: (s) => (s === "kanban" ? [{ type: "StaticText", AXUniqueId: "pipelines.list", frame: cadre(20, 100, 100, 44) }] : undefined) }),
  );
  assert.equal(appaire.status, 2);
  assert.equal(appaire.stderr.trim(), "simulateur appairé : la recette exige un simulateur jamais appairé au Mac");
  assert.equal(appaire.rapport, "", "aucun rapport écrit quand la recette ne conclut pas");
});

test("marqueur : vrai sur la surface annoncée, faux sur la liste racine, un écran plein « non connecté » ou « connexion en cours », ou la feuille sur kanban", () => {
  const sonde = (surface: string, elements: Element[]) => {
    const f = path.join(frais("marqueur"), "releve.json");
    fs.writeFileSync(f, JSON.stringify([application(), ...elements]));
    const r = spawnSync("python3", [ANALYSEUR, "marqueur", surface, f], { encoding: "utf8" });
    assert.equal(r.stdout + r.stderr, "", "aucune sortie texte");
    return r.status;
  };
  for (const s of SURFACES) assert.equal(sonde(s, marqueurPropre(s)), 0, s);
  for (const s of SURFACES) assert.equal(sonde(s, []), 1, `${s} vide`);
  const racine: Element = { type: "Button", AXUniqueId: "ios.section.memory", frame: cadre(20, 100, 300, 60) };
  assert.equal(sonde("home", [...marqueurPropre("home"), racine]), 1);
  for (const id of ["ios.connexion.horsLigne.ecran", "ios.connexion.enCours.ecran", "ios.connexion.cause", "ios.connexion.attente"]) {
    assert.equal(sonde("home", [...marqueurPropre("home"), { type: "StaticText", AXUniqueId: id, frame: cadre(20, 100, 300, 60) }]), 1, id);
  }
  const bandeau: Element = { type: "StaticText", AXUniqueId: "ios.connexion.message", frame: cadre(20, 100, 300, 60) };
  assert.equal(sonde("home", [...marqueurPropre("home"), bandeau]), 0, "un bandeau au-dessus des données n'exclut pas la surface");
  assert.equal(sonde("kanban", [...marqueurPropre("kanban"), ...marqueurPropre("kanban-fiche")]), 1);
  assert.equal(sonde("project", [{ type: "StaticText", AXLabel: "Projet", frame: cadre(20, 100, 100, 44) }]), 1, "libellé sans type Heading");
  assert.equal(sonde("project", [{ type: "StaticText", AXUniqueId: "ios.projet.start", frame: cadre(20, 100, 100, 44) }]), 0);
  assert.equal(sonde("stats", [{ type: "StaticText", AXUniqueId: "ios.screen.stats", frame: cadre(20, 100, 100, 44) }]), 0);
  const inconnue = spawnSync("python3", [ANALYSEUR, "marqueur", "autre", "x.json"], { encoding: "utf8" });
  assert.equal(inconnue.status, 2);
});
