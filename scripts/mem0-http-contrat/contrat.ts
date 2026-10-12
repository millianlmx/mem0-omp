#!/usr/bin/env node
// Lanceur du contrat boîte noire mem0-http (spec S-1), appelé par
// `bash scripts/mem0-http-contrat.sh --run` depuis la racine du dépôt.
//
// Exerce par HTTP les 9 routes du serveur à tester. Celui-ci est soit DÉMARRÉ
// ici (commande MEM0_CONTRAT_START, défaut : le Python jetable de
// `mem0-http-contrat.sh --start-python`), une instance neuve par phase, soit
// EXTERNE (MEM0_CONTRAT_URL sans START), ce qui exige MEM0_CONTRAT_EXTERNE=1 et
// une instance vide. Le faux OpenAI (faux-openai.ts) remplace oMLX ; les cas
// vivent dans cas.ts, les formes dans formes.ts.
//
// `--capture-rang` (via `mem0-http-contrat.sh --capture-rang`) : au lieu du
// contrat, réécrit `attendu` et `graphe` de la fixture de rang (rang.json, ou
// MEM0_CONTRAT_RANG_FIXTURE) depuis une instance neuve du Python jetable.
//
// Codes : 0 conforme, 1 échec (cas, serveur muet ou arrêté), 2 pièce manquante
// (`non exécuté : <pièce>` en première ligne), 3 refus (`refus : …`).
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { AJOUT, analyserFixtureRang, aretesParCles, corpsRechercheRang, EchecCas, GRAPHE, PHASES, RECHERCHE_EXPLIQUEE } from "./cas.ts";
import type { Contexte, EntreeJournal, FixtureRang, Groupe, LigneExpliquee, Phase, Requete } from "./cas.ts";
import { demarrerFauxOpenAI, JETON_OPENAI, MODELE_CHAT, MODELE_EMBEDDINGS } from "./faux-openai.ts";
import type { FauxOpenAI } from "./faux-openai.ts";
import { verifierForme } from "./formes.ts";

export const CODES_SORTIE = { conforme: 0, echec: 1, nonExecute: 2, refus: 3 } as const;

const DELAI_REQUETE_MS = 60_000;
const DELAI_SANTE_MS = 120_000;
const INTERVALLE_SANTE_MS = 250;
const DELAI_ARRET_MS = 10_000;
const LIGNES_JOURNAL = 40;
const RETRAIT = "      ";
/** Fixture de rang par défaut (MEM0_CONTRAT_RANG_FIXTURE la remplace). */
const FIXTURE_RANG_DEFAUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "rang.json");
/** Versions du Python jetable de la capture (mem0-http, venv et docker-compose.yml). */
const SOURCE_RANG = { mem0ai: "2.2.1", fastembed: "0.8.1", qdrant: "1.19.0" } as const;
/** Tranches de nombre de mots des requêtes (condition (b) de la capture), bornes incluses. */
const TRANCHES_MOTS: readonly (readonly [number, number])[] = [
  [1, 3],
  [4, 6],
  [7, 9],
  [10, 15],
  [16, Number.POSITIVE_INFINITY],
];

/** Fin de run anticipée : code de sortie et lignes à imprimer sur stdout. */
class Arret extends Error {
  readonly code: number;
  readonly lignes: readonly string[];
  constructor(code: number, lignes: readonly string[]) {
    super(lignes.join("\n"));
    this.code = code;
    this.lignes = lignes;
  }
}

type Config = {
  url: string | null;
  hote: string;
  port: number | null;
  start: string;
  externe: boolean;
  jetonExterne: string | null;
  infer: boolean;
  portOpenAI: number;
  /** Chemin de la fixture de rang, tel qu'imprimé dans les messages. */
  fixtureRang: string;
};

/** Lit les variables MEM0_CONTRAT_* (vide = absente) ; toute forme invalide → refus. */
function lireConfig(env: NodeJS.ProcessEnv): Config {
  const brut = (nom: string): string => env[nom] ?? "";
  let url: string | null = null;
  let hote = "127.0.0.1";
  let port: number | null = null;
  const urlBrute = brut("MEM0_CONTRAT_URL");
  if (urlBrute !== "") {
    const m = /^http:\/\/([^/:?#@\s]+):(\d{1,5})\/?$/.exec(urlBrute);
    const p = m ? Number(m[2]) : 0;
    if (!m || p < 1 || p > 65535) {
      throw new Arret(CODES_SORTIE.refus, [
        `refus : MEM0_CONTRAT_URL invalide (${urlBrute}) — attendu http://<hôte>:<port>`,
      ]);
    }
    url = `http://${m[1]}:${p}`;
    hote = m[1];
    port = p;
  }
  const infer = brut("MEM0_CONTRAT_INFER");
  if (infer !== "" && infer !== "0" && infer !== "1") {
    throw new Arret(CODES_SORTIE.refus, [`refus : MEM0_CONTRAT_INFER doit valoir 0 ou 1 (${infer})`]);
  }
  const portOpenAIBrut = brut("MEM0_CONTRAT_OPENAI_PORT");
  const portOpenAI = portOpenAIBrut === "" ? 0 : Number(portOpenAIBrut);
  if (!/^\d{1,5}$/.test(portOpenAIBrut || "0") || portOpenAI > 65535) {
    throw new Arret(CODES_SORTIE.refus, [`refus : MEM0_CONTRAT_OPENAI_PORT invalide (${portOpenAIBrut})`]);
  }
  const jeton = brut("MEM0_CONTRAT_TOKEN");
  return {
    url,
    hote,
    port,
    start: brut("MEM0_CONTRAT_START"),
    externe: brut("MEM0_CONTRAT_EXTERNE") === "1",
    jetonExterne: jeton === "" ? null : jeton,
    infer: infer !== "0",
    portOpenAI,
    fixtureRang: brut("MEM0_CONTRAT_RANG_FIXTURE") || path.relative(process.cwd(), FIXTURE_RANG_DEFAUT),
  };
}

/** Un port TCP libre sur 127.0.0.1 au moment de l'appel. */
async function portLibre(): Promise<number> {
  const serveur = http.createServer();
  const ecoute = Promise.withResolvers<void>();
  serveur.once("error", ecoute.reject);
  serveur.listen(0, "127.0.0.1", () => ecoute.resolve());
  await ecoute.promise;
  const { port } = serveur.address() as AddressInfo; // écoute TCP : jamais un chemin de socket
  const fermeture = Promise.withResolvers<void>();
  serveur.close(() => fermeture.resolve());
  await fermeture.promise;
  return port;
}

/** Les dernières lignes d'un journal, indentées pour le rapport. */
function finDeJournal(fichier: string, n: number): string[] {
  let texte = "";
  try {
    texte = fs.readFileSync(fichier, "utf8").replace(/\n+$/, "");
  } catch {
    return [];
  }
  if (texte === "") return [];
  return texte
    .split("\n")
    .slice(-n)
    .map((ligne) => `${RETRAIT}${ligne}`);
}

function messageErreur(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  if (e.name === "TimeoutError") return `délai de ${DELAI_REQUETE_MS / 1000} s dépassé`;
  const cause = e.cause instanceof Error ? (("code" in e.cause && String(e.cause.code)) || e.cause.message) : "";
  return cause ? `${e.message} (${cause})` : e.message;
}

/** Lit et valide la fixture de rang ; illisible ou mal formée → refus (code 3). */
function lireFixtureRang(chemin: string): FixtureRang {
  try {
    return analyserFixtureRang(fs.readFileSync(chemin, "utf8"));
  } catch (e) {
    throw new Arret(CODES_SORTIE.refus, [`refus : fixture de rang illisible (${chemin}) : ${messageErreur(e)}`]);
  }
}

/** Capture refusée (code 1) : chaque condition manquée est nommée, la fixture n'est pas écrite. */
function refuserCapture(manquees: readonly string[]): number {
  console.log("capture du rang refusée, fixture non écrite :");
  for (const m of manquees) console.log(`${RETRAIT}${m}`);
  return CODES_SORTIE.echec;
}

/** Serveur démarré pour une phase : groupe de processus détaché + WORKDIR neuf. */
type Instance = {
  enfant: ChildProcess;
  workdir: string;
  journal: string;
  /** Code (ou signal) de sortie, posé dès que le chef de groupe s'arrête. */
  sortie: string | null;
  fin: Promise<void>;
};

/** Le groupe de processus a-t-il encore un membre ? */
function groupeVivant(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function arreterInstance(instance: Instance): Promise<void> {
  const pid = instance.enfant.pid;
  if (pid !== undefined && groupeVivant(pid)) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // Groupe déjà vide entre le test et le signal.
    }
    const limite = Date.now() + DELAI_ARRET_MS;
    while (groupeVivant(pid) && Date.now() < limite) await pause(100);
    if (groupeVivant(pid)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Idem.
      }
    }
  }
  fs.rmSync(instance.workdir, { recursive: true, force: true });
}

class Lanceur {
  readonly config: Config;
  readonly tmp: string;
  faux: FauxOpenAI | null = null;
  instance: Instance | null = null;
  enTete = false;
  readonly entrees: EntreeJournal[] = [];
  executes = 0;
  echecs = 0;
  fixture: FixtureRang | null = null;

  constructor(config: Config) {
    this.config = config;
    this.tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mem0-contrat-"));
  }

  /** Arrêt de tout ce qui a été démarré ; idempotent, appelé sur tous les chemins. */
  async nettoyer(): Promise<void> {
    const instance = this.instance;
    this.instance = null;
    if (instance) await arreterInstance(instance);
    const faux = this.faux;
    this.faux = null;
    if (faux) await faux.fermer();
    fs.rmSync(this.tmp, { recursive: true, force: true });
  }

  imprimerEnTete(url: string): void {
    if (this.enTete || !this.faux) return;
    this.enTete = true;
    const mode = this.config.url !== null && this.config.start === "" ? "externe" : "démarré";
    console.log(`contrat mem0-http — cible ${url} (mode ${mode}) — faux OpenAI ${this.faux.url}`);
  }

  /** GET /memory/all doit répondre 200 avec total === 0 ; sinon refus. */
  async exigerVacuite(url: string, jeton: string | null, refusNonVide: (n: number) => string): Promise<void> {
    let reponse: Response;
    try {
      reponse = await fetch(`${url}/memory/all`, {
        headers: jeton === null ? {} : { "X-Mem0-Token": jeton },
        signal: AbortSignal.timeout(DELAI_REQUETE_MS),
      });
    } catch (e) {
      throw new Arret(CODES_SORTIE.refus, [`refus : GET /memory/all a échoué (${messageErreur(e)}) ; vacuité non prouvée`]);
    }
    let total: unknown;
    try {
      const corps: unknown = await reponse.json();
      total = corps !== null && typeof corps === "object" && "total" in corps ? corps.total : undefined;
    } catch {
      total = undefined;
    }
    if (reponse.status !== 200 || typeof total !== "number") {
      throw new Arret(CODES_SORTIE.refus, [`refus : GET /memory/all a répondu ${reponse.status} ; vacuité non prouvée`]);
    }
    if (total !== 0) throw new Arret(CODES_SORTIE.refus, [refusNonVide(total)]);
  }

  /** Démarre la commande du serveur à tester pour une phase et attend /health en 200. */
  async demarrer(phase: Phase, url: string, hote: string, port: number): Promise<void> {
    const faux = this.faux;
    if (!faux || phase.jetonServeur === null) throw new Error("demarrer : faux OpenAI ou jeton absent");
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "mem0-contrat-workdir-"));
    const journal = path.join(this.tmp, `serveur-${phase.nom}.log`);
    const fd = fs.openSync(journal, "w");
    const commande = this.config.start || "bash scripts/mem0-http-contrat.sh --start-python";
    const enfant = spawn("bash", ["-c", commande], {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: {
        ...process.env,
        MEM0_CONTRAT_HOST: hote,
        MEM0_CONTRAT_PORT: String(port),
        MEM0_CONTRAT_WORKDIR: workdir,
        MEM0_HTTP_TOKEN: phase.jetonServeur,
        OMLX_BASE_URL: faux.url,
        OMLX_API_TOKEN: JETON_OPENAI,
        OMLX_LLM_MODEL: MODELE_CHAT,
        OMLX_EMBED_MODEL: MODELE_EMBEDDINGS,
        EMBEDDING_DIMS: "1024",
        OMP_INSTALLATION_TOKEN: "",
      },
    });
    fs.closeSync(fd);
    const sortie = Promise.withResolvers<void>();
    const instance: Instance = { enfant, workdir, journal, sortie: null, fin: sortie.promise };
    enfant.once("exit", (code, signal) => {
      instance.sortie = code === null ? String(signal) : String(code);
      sortie.resolve();
    });
    enfant.once("error", (e) => {
      instance.sortie = `erreur ${e.message}`;
      sortie.resolve();
    });
    this.instance = instance;

    const limite = Date.now() + DELAI_SANTE_MS;
    for (;;) {
      if (instance.sortie !== null) {
        if (instance.sortie === "2") {
          const premiere = fs.readFileSync(journal, "utf8").split("\n")[0] ?? "";
          throw new Arret(CODES_SORTIE.nonExecute, [premiere]);
        }
        throw new Arret(CODES_SORTIE.echec, [
          `le serveur à tester s'est arrêté (code ${instance.sortie}) avant de répondre sur /health`,
          ...finDeJournal(journal, LIGNES_JOURNAL),
        ]);
      }
      try {
        const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) });
        await r.body?.cancel();
        if (r.status === 200) return;
      } catch {
        // Pas encore à l'écoute.
      }
      if (Date.now() >= limite) {
        throw new Arret(CODES_SORTIE.echec, [
          `le serveur à tester n'a pas répondu sur /health en ${DELAI_SANTE_MS / 1000} s`,
          ...finDeJournal(journal, LIGNES_JOURNAL),
        ]);
      }
      await Promise.race([pause(INTERVALLE_SANTE_MS), instance.fin]);
    }
  }

  contexte(phase: string, url: string, jetonDefaut: string | null, ecarts: string[]): Contexte {
    return {
      appeler: (requete) => this.appeler(phase, url, jetonDefaut, requete),
      constater: (condition, ecart) => {
        if (!condition) ecarts.push(ecart);
      },
      journal: () => this.entrees,
      compteursOpenAI: () => this.faux?.compteurs() ?? { embeddings: 0, chat: 0 },
      requetesChat: () => this.faux?.requetesChat() ?? [],
      requetesEmbeddings: () => this.faux?.requetesEmbeddings() ?? [],
      fixtureRang: () => {
        if (!this.fixture) throw new Error("fixture de rang non chargée (erreur de programmation du lanceur)");
        return this.fixture;
      },
    };
  }

  async appeler(phase: string, url: string, jetonDefaut: string | null, requete: Requete): Promise<unknown> {
    const route = `${requete.methode} ${requete.gabarit}`;
    const jeton = requete.jeton === undefined ? jetonDefaut : requete.jeton;
    const attendu = requete.statut ?? 200;
    const entetes: Record<string, string> = {};
    if (requete.corps !== undefined) entetes["content-type"] = "application/json";
    if (jeton !== null) entetes["X-Mem0-Token"] = jeton;
    let reponse: Response;
    try {
      reponse = await fetch(`${url}${requete.chemin ?? requete.gabarit}`, {
        method: requete.methode,
        headers: entetes,
        body: requete.corps === undefined ? undefined : JSON.stringify(requete.corps),
        signal: AbortSignal.timeout(DELAI_REQUETE_MS),
      });
    } catch (e) {
      throw new EchecCas([`${route} : ${messageErreur(e)}`]);
    }
    this.entrees.push({ phase, route, jeton: jeton !== null, statut: reponse.status });
    if (reponse.status !== attendu) {
      await reponse.body?.cancel();
      throw new EchecCas([`${route} : statut attendu ${attendu}, reçu ${reponse.status}`]);
    }
    if (attendu < 200 || attendu > 299) {
      if (requete.corpsErreur === undefined) {
        await reponse.body?.cancel();
        return null;
      }
      const brut = await reponse.text();
      let conforme = (reponse.headers.get("content-type") ?? "").startsWith("application/json");
      try {
        conforme &&= isDeepStrictEqual(JSON.parse(brut), requete.corpsErreur);
      } catch {
        conforme = false;
      }
      if (!conforme) {
        throw new EchecCas([`${route} : corps d'erreur attendu ${JSON.stringify(requete.corpsErreur)}, reçu ${brut}`]);
      }
      return null;
    }
    const texte = await reponse.text();
    let corps: unknown;
    try {
      corps = JSON.parse(texte);
    } catch {
      throw new EchecCas([`${route} : corps JSON illisible : ${texte.slice(0, 200)}`]);
    }
    if (requete.forme === undefined) {
      throw new EchecCas([`${route} : réponse ${reponse.status} sans forme déclarée (erreur de programmation du cas)`]);
    }
    const ecarts = verifierForme(route, requete.forme, corps);
    if (ecarts.length > 0) throw new EchecCas(ecarts.map((e) => e.message));
    return corps;
  }

  /** Exécute un groupe : premier échec → cas restants rapportés SKIP. */
  async executerGroupe(phase: Phase, groupe: Groupe, url: string, jetonDefaut: string | null): Promise<void> {
    const prefixe = `${phase.nom}/${groupe.nom}`;
    if (groupe.infer && !this.config.infer) {
      console.log(`SKIP  ${prefixe} · groupe infer=true désactivé (MEM0_CONTRAT_INFER=0)`);
      return;
    }
    if (groupe.horsExterne && this.estExterne()) {
      console.log(`SKIP  ${prefixe} · non applicable à une instance externe`);
      return;
    }
    const tous = groupe.cas();
    for (const [i, cas] of tous.entries()) {
      const ecarts: string[] = [];
      try {
        await cas.executer(this.contexte(phase.nom, url, jetonDefaut, ecarts));
      } catch (e) {
        ecarts.push(...(e instanceof EchecCas ? e.ecarts : [messageErreur(e)]));
      }
      this.executes += 1;
      if (ecarts.length === 0) {
        console.log(`PASS  ${prefixe} · ${cas.libelle}`);
      } else {
        this.echecs += 1;
        console.log(`FAIL  ${prefixe} · ${cas.libelle}`);
        for (const ligne of ecarts.flatMap((e) => e.split("\n"))) console.log(`${RETRAIT}${ligne}`);
      }
      this.exigerInstanceVivante();
      if (ecarts.length > 0) {
        const reste = tous.length - i - 1;
        if (reste > 0) {
          console.log(`SKIP  ${prefixe} · ${reste} cas restant(s) non exécuté(s) après l'échec de « ${cas.libelle} »`);
        }
        return;
      }
    }
  }

  /** Un serveur démarré qui s'arrête en cours de phase met fin au run (code 1). */
  exigerInstanceVivante(): void {
    const instance = this.instance;
    if (!instance || instance.sortie === null) return;
    throw new Arret(CODES_SORTIE.echec, [
      `le serveur à tester s'est arrêté (code ${instance.sortie}) en cours de route`,
      ...finDeJournal(instance.journal, LIGNES_JOURNAL),
    ]);
  }

  /**
   * `--capture-rang` : rejoue la fixture sur une instance NEUVE du Python
   * jetable, contrôle sa couverture (a)-(h) et réécrit `attendu` et `graphe`.
   */
  async capturer(): Promise<number> {
    const { config } = this;
    if (config.start !== "" || config.url !== null) {
      throw new Arret(CODES_SORTIE.refus, [
        "refus : la capture du rang vise le serveur Python jetable ; retire MEM0_CONTRAT_START et MEM0_CONTRAT_URL",
      ]);
    }
    const chemin = config.fixtureRang;
    const f = lireFixtureRang(chemin);

    const manquees: string[] = [];
    const clesCorpus = f.corpus.map((s) => s.cle);
    const clesRequetes = f.requetes.map((q) => q.cle);
    if (
      f.corpus.length < 12 ||
      f.requetes.length < 8 ||
      new Set(clesCorpus).size !== clesCorpus.length ||
      new Set(clesRequetes).size !== clesRequetes.length
    ) {
      manquees.push(
        `(a) au moins 12 souvenirs, au moins 8 requêtes et des clés uniques (${f.corpus.length} souvenirs, ${f.requetes.length} requêtes)`,
      );
    }
    const mots = f.requetes.map((q) => q.query.split(/\s+/u).filter(Boolean).length);
    const tranchesVides = TRANCHES_MOTS.filter(([min, max]) => !mots.some((n) => n >= min && n <= max));
    if (tranchesVides.length > 0) {
      const noms = tranchesVides.map(([min, max]) => (max === Number.POSITIVE_INFINITY ? `≥ ${min}` : `${min}-${max}`));
      manquees.push(`(b) au moins une requête dans chaque tranche de mots ; aucune en ${noms.join(", ")}`);
    }
    if (manquees.length > 0) return refuserCapture(manquees);

    try {
      this.faux = await demarrerFauxOpenAI({ port: config.portOpenAI });
    } catch (e) {
      throw new Arret(CODES_SORTIE.echec, [messageErreur(e)]);
    }
    const port = await portLibre();
    const url = `http://127.0.0.1:${port}`;
    await this.demarrer({ nom: "rang", jetonServeur: "", groupes: [] }, url, config.hote, port);
    await this.exigerVacuite(url, null, (n) => `refus : l'instance démarrée n'est pas vide (${n} souvenir(s))`);

    const ecarts: string[] = [];
    const ctx = this.contexte("rang", url, null, ecarts);
    const cles = new Map<string, string>();
    const limitees = new Map<string, LigneExpliquee[]>();
    const completes = new Map<string, LigneExpliquee[]>();
    let graphe: { total: number; threshold: number; top_k: number; edges: { source: string; target: string; score: number }[] };
    try {
      for (const s of f.corpus) {
        const r = (await ctx.appeler({
          methode: "POST",
          gabarit: "/memory/add",
          corps: { text: s.texte, agent_id: f.agent_id, infer: false },
          forme: AJOUT,
        })) as { results: { id: string }[] };
        const id = r.results[0]?.id;
        if (id === undefined) throw new EchecCas([`POST /memory/add : aucun souvenir créé pour ${s.cle}`]);
        cles.set(id, s.cle);
      }
      for (const q of f.requetes) {
        for (const [lignes, complete] of [
          [limitees, false],
          [completes, true],
        ] as const) {
          const r = (await ctx.appeler({
            methode: "POST",
            gabarit: "/memory/search",
            corps: corpsRechercheRang(f, q, complete),
            forme: RECHERCHE_EXPLIQUEE,
          })) as { results: LigneExpliquee[] };
          lignes.set(q.cle, r.results);
        }
      }
      graphe = (await ctx.appeler({ methode: "GET", gabarit: "/memory/graph", forme: GRAPHE })) as typeof graphe;
    } catch (e) {
      if (!(e instanceof EchecCas)) throw e;
      throw new Arret(CODES_SORTIE.echec, ["capture du rang interrompue :", ...e.ecarts.map((x) => `${RETRAIT}${x}`)]);
    }
    const cleDe = (id: string): string => cles.get(id) ?? id;
    const attendus = new Map(f.requetes.map((q) => [q.cle, (limitees.get(q.cle) ?? []).map((s) => cleDe(s.id))]));

    const reordonnee = f.requetes.some((q) => {
      const lignes = limitees.get(q.cle) ?? [];
      const parCosinus = [...lignes].sort((x, y) => y.score_details.semantic_score - x.score_details.semantic_score);
      return !isDeepStrictEqual(lignes.map((s) => s.id), parCosinus.map((s) => s.id));
    });
    if (!reordonnee) manquees.push("(c) au moins une requête dont attendu diffère de l'ordre par semantic_score décroissant");

    const maxPossibles = new Set(f.requetes.map((q) => completes.get(q.cle)?.[0]?.score_details.max_possible_score));
    if (!maxPossibles.has(1) || !maxPossibles.has(2)) {
      manquees.push("(d) au moins une requête à max_possible_score 1 et au moins une à 2");
    }

    if (!f.requetes.some((q) => q.limit < (completes.get(q.cle) ?? []).length)) {
      manquees.push("(e) au moins une requête dont limit est inférieur au nombre de lignes rendues sans limite");
    }

    const { requete, cle } = f.seuil_avant_fusion;
    const idSeuil = [...cles].find(([, c]) => c === cle)?.[0];
    const ligneSeuil = (completes.get(requete) ?? []).find((s) => s.id === idSeuil);
    if (
      idSeuil === undefined ||
      !limitees.has(requete) ||
      (limitees.get(requete) ?? []).some((s) => s.id === idSeuil) ||
      ligneSeuil === undefined ||
      ligneSeuil.score_details.bm25_score <= 0
    ) {
      manquees.push(
        `(f) seuil_avant_fusion (${requete}, ${cle}) : la clé doit être absente au threshold de la requête et présente avec bm25_score > 0 à threshold 0`,
      );
    }

    const exAequo = f.requetes.filter((q) => {
      const lignes = completes.get(q.cle) ?? [];
      return lignes.some((s, i) => i > 0 && Math.abs(lignes[i - 1].score - s.score) < 1e-6);
    });
    if (exAequo.length > 0) {
      manquees.push(`(g) aucun ex-aequo (|Δscore| ≥ 1e-6) ; ex-aequo dans ${exAequo.map((q) => q.cle).join(", ")}`);
    }

    const degres = new Map<string, number>();
    for (const e of graphe.edges) {
      for (const id of [e.source, e.target]) degres.set(id, (degres.get(id) ?? 0) + 1);
    }
    if (graphe.edges.length === 0 || Math.max(0, ...degres.values()) < 9) {
      manquees.push(`(h) au moins une arête et un nœud touché par au moins 9 arêtes (${graphe.edges.length} arête(s))`);
    }
    if (manquees.length > 0) return refuserCapture(manquees);

    const aretes = aretesParCles(graphe.edges, cleDe);
    const capturee: FixtureRang = {
      format: 1,
      source: { ...SOURCE_RANG, capture: new Date().toISOString() },
      agent_id: f.agent_id,
      corpus: f.corpus.map((s) => ({ cle: s.cle, texte: s.texte })),
      requetes: f.requetes.map((q) => ({
        cle: q.cle,
        query: q.query,
        limit: q.limit,
        threshold: q.threshold,
        attendu: attendus.get(q.cle) ?? [],
      })),
      seuil_avant_fusion: { requete, cle },
      graphe: { total: graphe.total, threshold: graphe.threshold, top_k: graphe.top_k, aretes },
    };
    fs.writeFileSync(chemin, `${JSON.stringify(capturee, null, 2)}\n`);
    console.log(`fixture de rang capturée : ${chemin} (${f.requetes.length} requêtes, ${aretes.length} arêtes)`);
    return CODES_SORTIE.conforme;
  }

  estExterne(): boolean {
    return this.config.url !== null && this.config.start === "";
  }

  async executer(): Promise<number> {
    const { config } = this;
    // Mode externe : refus AVANT toute requête vers l'URL sans opt-in, puis la
    // vacuité est la première et seule requête avant le contrat.
    if (this.estExterne() && config.url !== null) {
      if (!config.externe) {
        throw new Arret(CODES_SORTIE.refus, [
          `refus : MEM0_CONTRAT_URL=${config.url} vise une instance externe ; pose MEM0_CONTRAT_EXTERNE=1 pour l'accepter (instance vide exigée)`,
        ]);
      }
      const url = config.url;
      await this.exigerVacuite(
        url,
        config.jetonExterne,
        (n) => `refus : l'instance ${url} contient déjà ${n} souvenir(s) ; le contrat n'écrit que dans une instance vide`,
      );
    }

    // Phase rang : la fixture commitée est exigée lisible ET capturée avant tout
    // démarrage (sautée avec la phase en mode externe).
    if (!this.estExterne()) {
      const fixture = lireFixtureRang(config.fixtureRang);
      if (fixture.graphe === undefined || fixture.requetes.some((q) => q.attendu === undefined)) {
        throw new Arret(CODES_SORTIE.refus, [
          `refus : fixture de rang non capturée (${config.fixtureRang}) — lance bash scripts/mem0-http-contrat.sh --capture-rang`,
        ]);
      }
      this.fixture = fixture;
    }

    try {
      this.faux = await demarrerFauxOpenAI({ port: config.portOpenAI });
    } catch (e) {
      throw new Arret(CODES_SORTIE.echec, [messageErreur(e)]);
    }

    // Mode démarré : même hôte:port pour toutes les phases (celui de l'URL, sinon
    // un port libre de 127.0.0.1 choisi une fois).
    const port = config.port ?? (this.estExterne() ? null : await portLibre());
    const url = config.url ?? `http://127.0.0.1:${port}`;

    for (const phase of PHASES) {
      if (phase.groupes.length === 0) continue;
      let jetonDefaut: string | null = null;
      if (phase.jetonServeur !== null && this.estExterne()) {
        if (phase.jetonServeur !== "") {
          for (const groupe of phase.groupes) {
            console.log(`SKIP  ${phase.nom}/${groupe.nom} · non applicable à une instance externe`);
          }
          continue;
        }
        this.imprimerEnTete(url);
        jetonDefaut = config.jetonExterne;
      } else if (phase.jetonServeur !== null && port !== null) {
        await this.demarrer(phase, url, config.hote, port);
        this.imprimerEnTete(url);
        await this.exigerVacuite(
          url,
          phase.jetonServeur === "" ? null : phase.jetonServeur,
          (n) => `refus : l'instance démarrée n'est pas vide (${n} souvenir(s))`,
        );
      }
      for (const groupe of phase.groupes) await this.executerGroupe(phase, groupe, url, jetonDefaut);
      const instance = this.instance;
      this.instance = null;
      if (instance) await arreterInstance(instance);
    }

    const compteurs = this.faux.compteurs();
    console.log(`faux OpenAI : ${compteurs.embeddings} requête(s) embeddings, ${compteurs.chat} requête(s) chat`);
    if (this.echecs === 0) {
      console.log(`Contrat conforme : ${this.executes} cas.`);
      return CODES_SORTIE.conforme;
    }
    console.log(`${this.echecs} échec(s) sur ${this.executes} cas.`);
    return CODES_SORTIE.echec;
  }
}

async function main(): Promise<number> {
  let lanceur: Lanceur;
  try {
    lanceur = new Lanceur(lireConfig(process.env));
  } catch (e) {
    if (!(e instanceof Arret)) throw e;
    for (const ligne of e.lignes) console.log(ligne);
    return e.code;
  }
  let signale = false;
  const surSignal = (): void => {
    if (signale) return;
    signale = true;
    void lanceur.nettoyer().finally(() => process.exit(CODES_SORTIE.echec));
  };
  process.once("SIGINT", surSignal);
  process.once("SIGTERM", surSignal);
  try {
    return await (process.argv[2] === "--capture-rang" ? lanceur.capturer() : lanceur.executer());
  } catch (e) {
    if (e instanceof Arret) {
      for (const ligne of e.lignes) console.log(ligne);
      return e.code;
    }
    console.log(`erreur interne du lanceur : ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    return CODES_SORTIE.echec;
  } finally {
    await lanceur.nettoyer();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code;
  });
}
