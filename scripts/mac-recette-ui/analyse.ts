// Analyse de la recette UI Mac (S-6 couverture, S-7 règles, S-8 exceptions,
// S-9 isolation, rapport et verdict de recette-ui-mac-automatisee).
//
// Tout ce fichier est PUR : aucune E/S, aucune date, aucun chemin. Seul
// scripts/mac-recette-ui/recette.ts lit `parcours.json`, les relevés, les
// captures et le fichier d'exceptions, puis écrit `rapport.json`/`rapport.md`.
//
// Déterminisme (AC-2) : `rapport.json` ne dépend que du catalogue, du parcours,
// des relevés et des exceptions — jamais de l'ordre de lecture des relevés. Les
// signalements sont triés par (rang de la surface, règle, clé) en ordre de
// points de code, pas en `localeCompare` (qui dépend de la locale du poste).
import { CATALOGUE, type Surface, type TypeSurface } from "./catalogue.ts";

// ── Formats d'entrée (S-6, S-3) ────────────────────────────────────────────

export type Cadre = { x: number; y: number; largeur: number; hauteur: number };

export type Noeud = {
  role: string;
  sousRole: string | null;
  identifiant: string | null;
  titre: string | null;
  description: string | null;
  valeur: string | null;
  cadre: Cadre | null;
  actions: string[];
  enfants: Noeud[];
};

export type Releve = {
  version: 1;
  surface: string;
  fenetre: { largeur: number; hauteur: number };
  racine: Noeud;
};

export type ConstatIsolation = {
  instancesUtilisateur: number[];
  premierPlan: { bundle: string | null; pid: number };
  preferences: string;
};

export type Isolation = {
  avant: ConstatIsolation;
  apres: ConstatIsolation;
  activations: { bundle: string; pid: number }[];
};

export type SurfaceParcours = {
  id: string;
  statut: "couverte" | "non-couverte";
  raison: string | null;
  fenetre: { largeur: number; hauteur: number } | null;
};

export type Parcours = {
  version: 1;
  isolation?: unknown;
  surfaces: SurfaceParcours[];
};

// ── Règles et signalements (S-7) ───────────────────────────────────────────

export const REGLES = ["hors-ecran", "identifiant-duplique", "cible-trop-petite"] as const;
export type Regle = (typeof REGLES)[number];

/** Libellés lisibles des règles, pour `rapport.md` (S-9). */
export const LIBELLES_REGLES: Record<Regle, string> = {
  "hors-ecran": "élément hors de la zone visible",
  "identifiant-duplique": "identifiant d'accessibilité dupliqué",
  "cible-trop-petite": "cible cliquable de moins de 20 × 20 pt",
};

/** Seuil HIG macOS (D-1) : une cible est signalée sous 20 pt de côté. */
export const TAILLE_MINIMALE_CIBLE = 20;

/** Chrome système de la fenêtre : jamais jugé (S-7). */
const SOUS_ROLES_CHROME: Record<string, true> = {
  AXCloseButton: true,
  AXMinimizeButton: true,
  AXZoomButton: true,
  AXFullScreenButton: true,
};

/** Rôles cliquables (S-7) ; tout nœud qui porte `AXPress` en est une aussi. */
const ROLES_CIBLES: Record<string, true> = {
  AXButton: true,
  AXCheckBox: true,
  AXRadioButton: true,
  AXPopUpButton: true,
  AXMenuButton: true,
  AXLink: true,
  AXDisclosureTriangle: true,
  AXComboBox: true,
  AXTextField: true,
  AXSlider: true,
  AXIncrementor: true,
};

/**
 * Un signalement (S-7). `libelle` et `cadre` ne servent qu'à `rapport.md` :
 * `rapport.json` ne les porte pas (un cadre bouge avec l'écran du poste).
 */
export type Signalement = {
  surface: string;
  regle: Regle;
  cle: string;
  role: string;
  occurrences: number;
  libelle: string | null;
  cadre: Cadre | null;
};

const arrondi2 = (v: number): number => Math.round(v * 100) / 100;

const nonVide = (s: string | null | undefined): s is string => typeof s === "string" && s !== "";

function libelleDe(n: Noeud): string | null {
  for (const v of [n.titre, n.description, n.valeur, n.identifiant]) if (nonVide(v)) return v;
  return null;
}

function cadreUtilisable(c: Cadre | null): c is Cadre {
  return c !== null && c.largeur > 0 && c.hauteur > 0;
}

type Visite = { noeud: Noeud; chemin: string; sousZoneDefilante: boolean };

/** Parcours préfixe sous la racine (exclue), enfants dans l'ordre de `AXChildren`. */
function visiter(racine: Noeud): Visite[] {
  const out: Visite[] = [];
  const descendre = (parent: Noeud, cheminParent: string, sousZone: boolean): void => {
    const rangParRole = new Map<string, number>();
    for (const enfant of parent.enfants ?? []) {
      const rang = rangParRole.get(enfant.role) ?? 0;
      rangParRole.set(enfant.role, rang + 1);
      const segment = `${enfant.role}[${rang}]`;
      const chemin = cheminParent === "" ? segment : `${cheminParent}/${segment}`;
      out.push({ noeud: enfant, chemin, sousZoneDefilante: sousZone });
      descendre(enfant, chemin, sousZone || enfant.role === "AXScrollArea");
    }
  };
  descendre(racine, "", false);
  return out;
}

/** Les signalements d'UN relevé (S-7). Fonction pure. */
export function analyserReleve(releve: Releve): Signalement[] {
  const surface = releve.surface;
  const R = releve.racine.cadre;
  const visites = visiter(releve.racine).filter((v) => SOUS_ROLES_CHROME[v.noeud.sousRole ?? ""] !== true);

  const parIdentifiant = new Map<string, Visite[]>();
  for (const v of visites) {
    const id = v.noeud.identifiant;
    if (!nonVide(id)) continue;
    const liste = parIdentifiant.get(id) ?? [];
    liste.push(v);
    parIdentifiant.set(id, liste);
  }

  const cleDe = (v: Visite): string => {
    const id = v.noeud.identifiant;
    if (!nonVide(id)) return `chemin:${v.chemin}`;
    const liste = parIdentifiant.get(id) ?? [];
    return liste.length === 1 ? `id:${id}` : `id:${id}#${liste.indexOf(v) + 1}`;
  };

  const signalement = (v: Visite, regle: Regle, cle: string, occurrences: number): Signalement => ({
    surface,
    regle,
    cle,
    role: v.noeud.role,
    occurrences,
    libelle: libelleDe(v.noeud),
    cadre: v.noeud.cadre,
  });

  const out: Signalement[] = [];
  const dupliquesVus = new Set<string>();
  for (const v of visites) {
    const n = v.noeud;
    const id = n.identifiant;
    if (nonVide(id) && !dupliquesVus.has(id)) {
      const liste = parIdentifiant.get(id) ?? [];
      if (liste.length >= 2) {
        dupliquesVus.add(id);
        out.push(signalement(liste[0], "identifiant-duplique", `id:${id}`, liste.length));
      }
    }
    if (!cadreUtilisable(n.cadre)) continue;
    const c = n.cadre;
    if (
      R !== null &&
      !v.sousZoneDefilante &&
      (c.x < R.x - 1 ||
        c.y < R.y - 1 ||
        c.x + c.largeur > R.x + R.largeur + 1 ||
        c.y + c.hauteur > R.y + R.hauteur + 1)
    ) {
      out.push(signalement(v, "hors-ecran", cleDe(v), 1));
    }
    const estCible = ROLES_CIBLES[n.role] === true || (n.actions ?? []).includes("AXPress");
    if (estCible && (arrondi2(c.largeur) < TAILLE_MINIMALE_CIBLE || arrondi2(c.hauteur) < TAILLE_MINIMALE_CIBLE)) {
      out.push(signalement(v, "cible-trop-petite", cleDe(v), 1));
    }
  }
  return out;
}

// ── Exceptions (S-8) ───────────────────────────────────────────────────────

export type ExceptionEntree = {
  surface: string;
  regle: Regle;
  element: string;
  justification: string;
};

export type ExceptionInvalide = { index: number | null; raison: string };

export type ExceptionsLues = {
  /** Entrées valides, avec leur index 0-based dans le fichier. */
  valides: { index: number; entree: ExceptionEntree }[];
  invalides: ExceptionInvalide[];
};

/**
 * Valide le texte du fichier d'exceptions (S-8). `null` = fichier absent.
 * Un fichier illisible n'applique AUCUNE exception et donne une exception
 * invalide d'index `null`. Un doublon est jugé contre les entrées VALIDES qui
 * le précèdent : `n°<k>` est l'index 0-based de celle qui excepte à sa place.
 */
export function lireExceptions(texte: string | null, catalogue: readonly Surface[] = CATALOGUE): ExceptionsLues {
  const illisible = (raison: string): ExceptionsLues => ({
    valides: [],
    invalides: [{ index: null, raison: `fichier d'exceptions illisible : ${raison}` }],
  });
  if (texte === null) return illisible("fichier absent");
  let brut: unknown;
  try {
    brut = JSON.parse(texte);
  } catch {
    return illisible("JSON invalide");
  }
  if (!estObjet(brut) || brut.version !== 1) return illisible("version différente de 1");
  if (!Array.isArray(brut.exceptions)) return illisible("« exceptions » n'est pas un tableau");

  const ids = new Set(catalogue.map((s) => s.id));
  const regles: readonly string[] = REGLES;
  const valides: ExceptionsLues["valides"] = [];
  const invalides: ExceptionInvalide[] = [];
  brut.exceptions.forEach((e: unknown, index: number) => {
    const o = estObjet(e) ? e : {};
    const raison = (() => {
      if (o.surface !== "*" && !(typeof o.surface === "string" && ids.has(o.surface))) return "surface inconnue";
      if (!(typeof o.regle === "string" && regles.includes(o.regle))) return "règle inconnue";
      if (!(typeof o.element === "string" && o.element !== "")) return "élément manquant";
      if (!(typeof o.justification === "string" && o.justification.trim() !== "")) return "justification manquante";
      const double = valides.find(
        (v) => v.entree.surface === o.surface && v.entree.regle === o.regle && v.entree.element === o.element,
      );
      if (double !== undefined) return `doublon de l'exception n°${double.index}`;
      return null;
    })();
    if (raison !== null) {
      invalides.push({ index, raison });
      return;
    }
    valides.push({
      index,
      entree: {
        surface: o.surface as string,
        regle: o.regle as Regle,
        element: o.element as string,
        justification: o.justification as string,
      },
    });
  });
  return { valides, invalides };
}

// ── Isolation (S-9) ────────────────────────────────────────────────────────

export type JugementIsolation = { rompue: boolean; constats: string[] };

function estObjet(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function lireConstat(v: unknown): ConstatIsolation | null {
  if (!estObjet(v)) return null;
  const { instancesUtilisateur: pids, premierPlan: pp, preferences } = v;
  if (!Array.isArray(pids) || !pids.every((p) => Number.isInteger(p))) return null;
  if (!estObjet(pp) || !Number.isInteger(pp.pid) || !(pp.bundle === null || typeof pp.bundle === "string")) {
    return null;
  }
  if (typeof preferences !== "string") return null;
  return {
    instancesUtilisateur: pids as number[],
    premierPlan: { bundle: pp.bundle as string | null, pid: pp.pid as number },
    preferences,
  };
}

/** Les constats d'isolation de `parcours.json`, ou `null` s'ils sont absents ou mal formés. */
export function lireIsolation(v: unknown): Isolation | null {
  if (!estObjet(v)) return null;
  const avant = lireConstat(v.avant);
  const apres = lireConstat(v.apres);
  if (avant === null || apres === null || !Array.isArray(v.activations)) return null;
  const activations: Isolation["activations"] = [];
  for (const a of v.activations) {
    if (!estObjet(a) || typeof a.bundle !== "string" || !Number.isInteger(a.pid)) return null;
    activations.push({ bundle: a.bundle, pid: a.pid as number });
  }
  return { avant, apres, activations };
}

const listePids = (pids: number[]): string => (pids.length === 0 ? "aucune" : pids.join(", "));

/** Juge l'isolation de l'instance de l'utilisateur (S-9) : un constat par cause. */
export function jugerIsolation(isolation: unknown): JugementIsolation {
  const iso = lireIsolation(isolation);
  if (iso === null) return { rompue: true, constats: ["constats d'isolation absents"] };
  const { avant, apres, activations } = iso;
  const constats: string[] = [];
  if (listePids(avant.instancesUtilisateur) !== listePids(apres.instancesUtilisateur)) {
    constats.push(
      `instance de l'utilisateur changée : ${listePids(avant.instancesUtilisateur)} → ${listePids(apres.instancesUtilisateur)}`,
    );
  }
  if (avant.preferences !== apres.preferences) {
    constats.push("préférences com.omp.console modifiées pendant la recette");
  }
  for (const a of activations) constats.push(`activation de ${a.bundle} (pid ${a.pid})`);
  if (avant.premierPlan.bundle !== apres.premierPlan.bundle || avant.premierPlan.pid !== apres.premierPlan.pid) {
    constats.push(
      `app au premier plan changée : ${avant.premierPlan.bundle ?? "inconnue"} → ${apres.premierPlan.bundle ?? "inconnue"} ` +
        "(si vous avez changé d'app pendant la recette, relancez-la sans y toucher)",
    );
  }
  return { rompue: constats.length > 0, constats };
}

// ── Couverture, verdict, rapport (S-6, S-9) ────────────────────────────────

export type Verdict = "vert" | "defauts";

export type SurfaceRapport = {
  id: string;
  type: TypeSurface;
  statut: "couverte" | "non-couverte";
  raison: string | null;
  /** Pour `rapport.md` seulement (taille de fenêtre relevée par le parcours). */
  fenetre: { largeur: number; hauteur: number } | null;
};

export type SignalementRapport = Signalement & { exception: string | null };

export type Rapport = {
  version: 1;
  verdict: Verdict;
  surfaces: SurfaceRapport[];
  signalements: SignalementRapport[];
  exceptionsInvalides: ExceptionInvalide[];
  exceptionsSansObjet: { surface: string; regle: Regle; element: string }[];
  isolation: JugementIsolation & {
    /** Pour `rapport.md` seulement : les constats bruts (pids, empreintes). */
    releve: Isolation | null;
  };
};

export type EntreeAnalyse = {
  catalogue: readonly Surface[];
  /** `parcours.json` lu, ou `null` s'il est absent ou illisible. */
  parcours: unknown;
  /** Relevés lus, par id de fichier (`releves/<id>.json`) ; ordre indifférent. */
  releves: Map<string, unknown>;
  /** Ids dont `captures/<id>.png` existe et n'est pas vide. */
  captures: Set<string>;
  /** Texte du fichier d'exceptions, ou `null` s'il est absent. */
  exceptions: string | null;
};

function lireSurfacesParcours(parcours: unknown): Map<string, SurfaceParcours> {
  const out = new Map<string, SurfaceParcours>();
  if (!estObjet(parcours) || !Array.isArray(parcours.surfaces)) return out;
  for (const s of parcours.surfaces) {
    if (!estObjet(s) || typeof s.id !== "string" || out.has(s.id)) continue;
    if (s.statut !== "couverte" && s.statut !== "non-couverte") continue;
    const f = s.fenetre;
    out.set(s.id, {
      id: s.id,
      statut: s.statut,
      raison: typeof s.raison === "string" ? s.raison : null,
      fenetre:
        estObjet(f) && typeof f.largeur === "number" && typeof f.hauteur === "number"
          ? { largeur: f.largeur, hauteur: f.hauteur }
          : null,
    });
  }
  return out;
}

/** Un relevé est lisible s'il a la forme S-6 et désigne bien la surface de son fichier. */
function releveLisible(v: unknown, id: string): v is Releve {
  return estObjet(v) && v.version === 1 && v.surface === id && estObjet(v.racine) && typeof v.racine.role === "string";
}

const comparer = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** L'analyse complète d'un passage (S-6, S-7, S-8, S-9). Fonction pure. */
export function analyser(entree: EntreeAnalyse): Rapport {
  const { catalogue } = entree;
  const parcourues = lireSurfacesParcours(entree.parcours);

  const surfaces: SurfaceRapport[] = [];
  const bruts: Signalement[] = [];
  for (const s of catalogue) {
    const p = parcourues.get(s.id);
    const fenetre = p?.fenetre ?? null;
    const nonCouverte = (raison: string): void => {
      surfaces.push({ id: s.id, type: s.type, statut: "non-couverte", raison, fenetre });
    };
    if (p === undefined) {
      nonCouverte("absente du parcours");
      continue;
    }
    if (p.statut === "non-couverte") {
      nonCouverte(p.raison ?? "non couverte, sans raison donnée par le parcours");
      continue;
    }
    const releve = entree.releves.get(s.id);
    if (!entree.captures.has(s.id) || !releveLisible(releve, s.id)) {
      nonCouverte("capture ou relevé manquant");
      continue;
    }
    if (releve.racine.cadre === null || releve.racine.cadre === undefined) {
      nonCouverte("cadre de la surface illisible");
      continue;
    }
    surfaces.push({ id: s.id, type: s.type, statut: "couverte", raison: null, fenetre });
    bruts.push(...analyserReleve(releve));
  }

  const rang = new Map(catalogue.map((s, i) => [s.id, i]));
  bruts.sort(
    (a, b) =>
      (rang.get(a.surface) ?? 0) - (rang.get(b.surface) ?? 0) ||
      comparer(a.regle, b.regle) ||
      comparer(a.cle, b.cle),
  );

  const { valides, invalides } = lireExceptions(entree.exceptions, catalogue);
  const utilisees = new Set<number>();
  const signalements: SignalementRapport[] = bruts.map((sig) => {
    const e = valides.find(
      (v) => v.entree.regle === sig.regle && v.entree.element === sig.cle && (v.entree.surface === "*" || v.entree.surface === sig.surface),
    );
    if (e !== undefined) utilisees.add(e.index);
    return { ...sig, exception: e?.entree.justification ?? null };
  });
  const exceptionsSansObjet = valides
    .filter((v) => !utilisees.has(v.index))
    .map((v) => ({ surface: v.entree.surface, regle: v.entree.regle, element: v.entree.element }));

  const isolation = jugerIsolation(estObjet(entree.parcours) ? entree.parcours.isolation : undefined);
  const vert =
    surfaces.every((s) => s.statut === "couverte") &&
    signalements.every((s) => s.exception !== null) &&
    invalides.length === 0 &&
    !isolation.rompue;

  return {
    version: 1,
    verdict: vert ? "vert" : "defauts",
    surfaces,
    signalements,
    exceptionsInvalides: invalides,
    exceptionsSansObjet,
    isolation: { ...isolation, releve: estObjet(entree.parcours) ? lireIsolation(entree.parcours.isolation) : null },
  };
}

/**
 * `rapport.json` (S-9) : déterministe, sans date, durée, chemin absolu,
 * empreinte, cadre ni taille de fenêtre ; indenté de 2 espaces, `\n` final.
 */
export function serialiserRapportJson(r: Rapport): string {
  const json = {
    version: r.version,
    verdict: r.verdict,
    surfaces: r.surfaces.map(({ id, type, statut, raison }) => ({ id, type, statut, raison })),
    signalements: r.signalements.map(({ surface, regle, cle, role, occurrences, exception }) => ({
      surface,
      regle,
      cle,
      role,
      occurrences,
      exception,
    })),
    exceptionsInvalides: r.exceptionsInvalides,
    exceptionsSansObjet: r.exceptionsSansObjet,
    isolation: { rompue: r.isolation.rompue, constats: r.isolation.constats },
  };
  return `${JSON.stringify(json, null, 2)}\n`;
}

/** Une cellule de tableau Markdown : ni `|` ni saut de ligne ne cassent la ligne. */
const cellule = (v: string | null): string => (v === null || v === "" ? "—" : v.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " "));

function tableau(entetes: string[], lignes: string[][]): string[] {
  if (lignes.length === 0) return ["Aucun."];
  return [
    `| ${entetes.join(" | ")} |`,
    `|${entetes.map(() => "---").join("|")}|`,
    ...lignes.map((l) => `| ${l.join(" | ")} |`),
  ];
}

/** `rapport.md` (S-9) : lisible, peut porter pids, tailles et cadres. */
export function rendreRapportMd(r: Rapport): string {
  const lignes: string[] = [`# Recette Mac — ${r.verdict === "vert" ? "vert" : "défauts trouvés"}`, ""];

  lignes.push("## Surfaces", "");
  lignes.push(
    ...tableau(
      ["surface", "type", "statut", "raison", "capture", "taille de fenêtre"],
      r.surfaces.map((s) => [
        s.id,
        s.type,
        s.statut === "couverte" ? "couverte" : "non couverte",
        cellule(s.raison),
        s.statut === "couverte" ? `[captures/${s.id}.png](captures/${s.id}.png)` : "—",
        s.fenetre === null ? "—" : `${arrondi2(s.fenetre.largeur)} × ${arrondi2(s.fenetre.hauteur)} pt`,
      ]),
    ),
    "",
  );

  const colonnes = ["surface", "règle", "clé", "rôle", "libellé", "cadre"];
  const ligneSignalement = (s: SignalementRapport): string[] => [
    s.surface,
    LIBELLES_REGLES[s.regle] + (s.occurrences > 1 ? ` (${s.occurrences} occurrences)` : ""),
    cellule(s.cle),
    s.role,
    cellule(s.libelle),
    s.cadre === null
      ? "—"
      : `x ${arrondi2(s.cadre.x)}, y ${arrondi2(s.cadre.y)}, ${arrondi2(s.cadre.largeur)} × ${arrondi2(s.cadre.hauteur)}`,
  ];
  lignes.push("## Signalements non exceptés", "");
  lignes.push(...tableau(colonnes, r.signalements.filter((s) => s.exception === null).map(ligneSignalement)), "");
  lignes.push("## Signalements exceptés", "");
  lignes.push(
    ...tableau(
      [...colonnes, "justification"],
      r.signalements
        .filter((s) => s.exception !== null)
        .map((s) => [...ligneSignalement(s), cellule(s.exception)]),
    ),
    "",
  );

  lignes.push("## Exceptions invalides", "");
  lignes.push(
    ...tableau(
      ["exception", "raison"],
      r.exceptionsInvalides.map((e) => [e.index === null ? "fichier" : `n°${e.index}`, cellule(e.raison)]),
    ),
    "",
  );
  lignes.push("## Exceptions sans objet", "");
  lignes.push(
    ...tableau(
      ["surface", "règle", "élément"],
      r.exceptionsSansObjet.map((e) => [e.surface, e.regle, cellule(e.element)]),
    ),
    "",
  );

  lignes.push("## Isolation", "");
  const iso = r.isolation.releve;
  if (iso === null) {
    lignes.push("Constats d'isolation absents.");
  } else {
    const pp = (c: ConstatIsolation): string => `${c.premierPlan.bundle ?? "inconnue"} (pid ${c.premierPlan.pid})`;
    lignes.push(
      `- Instances de l'utilisateur (com.omp.console) : avant ${listePids(iso.avant.instancesUtilisateur)} · après ${listePids(iso.apres.instancesUtilisateur)}`,
      `- App au premier plan : avant ${pp(iso.avant)} · après ${pp(iso.apres)}`,
      `- Empreinte des préférences com.omp.console : avant ${iso.avant.preferences} · après ${iso.apres.preferences}`,
      `- Activations : ${iso.activations.length === 0 ? "aucune" : iso.activations.map((a) => `${a.bundle} (pid ${a.pid})`).join(", ")}`,
    );
  }
  if (r.isolation.rompue) lignes.push("", "Isolation rompue :", "", ...r.isolation.constats.map((c) => `- ${c}`));
  else lignes.push("", "Isolation intacte.");
  lignes.push("");
  return lignes.join("\n");
}

/** La dernière ligne du passage sur stdout (S-1), pour un verdict 0 ou 1. */
export function ligneVerdict(r: Rapport, cheminRapportMd: string): string {
  const exceptes = r.signalements.filter((s) => s.exception !== null).length;
  if (r.verdict === "vert") {
    return `✓ recette Mac : vert — ${r.surfaces.length} surfaces couvertes, ${exceptes} signalement(s) excepté(s). Rapport : ${cheminRapportMd}`;
  }
  const restants = r.signalements.length - exceptes;
  const nonCouvertes = r.surfaces.filter((s) => s.statut === "non-couverte").length;
  const rompue = r.isolation.rompue ? ", isolation rompue" : "";
  return (
    `✗ recette Mac : défauts trouvés — ${restants} signalement(s) non excepté(s), ${nonCouvertes} surface(s) non couverte(s), ` +
    `${r.exceptionsInvalides.length} exception(s) invalide(s)${rompue}. Rapport : ${cheminRapportMd}`
  );
}
