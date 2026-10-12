// Tests de preuve du contrat boîte noire mem0-http (`scripts/mem0-http-contrat.sh`),
// cible mem0-rs.
//
// Le contrat lui-même prouve AC-1 et AC-5…AC-13 en s'exécutant (section rust de
// check.sh, et CI) ; ce fichier prouve ce que le contrat ne peut pas constater
// de l'intérieur : le faux OpenAI déterministe (AC-3), le refus d'une cible non
// jetable (AC-15), le changement de cible sans toucher aux cas (AC-2), la
// détection des écarts de forme (AC-4) et la désactivation du groupe infer (AC-14).
//
// Les tests qui compilent mem0-rs ou lancent de vrais serveurs (mem0-rs, Qdrant)
// ne tournent qu'au premier niveau (`MEM0_CHECK_DEPTH` 0) : une copie jetable du
// dépôt ne les rejoue pas. Une pièce manquante (cargo, binaire) est un saut
// annoncé, ou un échec sous MEM0_OMP_REQUIRE_RUST=1. Les enfants sont ASYNCHRONES,
// car le proxy et l'enregistreur vivent dans ce processus et doivent répondre
// pendant que l'enfant tourne.
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { CODES_SORTIE } from "../../scripts/mem0-http-contrat/contrat.ts";
import { DIMENSIONS, demarrerFauxOpenAI, plonger } from "../../scripts/mem0-http-contrat/faux-openai.ts";
import { ROOT } from "../support/repo.ts";

/** Profondeur d'imbrication : 0 = suite lancée à la main ou par check.sh racine. */
const DEPTH = Number(process.env.MEM0_CHECK_DEPTH ?? "0");

/** Délai d'un test qui démarre de vrais serveurs. */
const DELAI_LOURD = 600_000;

/**
 * Environnement d'un enfant : celui du processus, sans les marqueurs de
 * travailleur de `node:test` ni aucune `MEM0_CONTRAT_*` héritée de l'opérateur —
 * seules les variables posées par le test comptent.
 */
function envEnfant(poses: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [cle, valeur] of Object.entries(process.env)) {
    if (valeur === undefined) continue;
    if (cle === "NODE_TEST_CONTEXT" || cle === "NODE_TEST_WORKER_ID" || cle.startsWith("MEM0_CONTRAT_")) continue;
    env[cle] = valeur;
  }
  return { ...env, ...poses };
}

type Resultat = { code: number | null; sortie: string };

function lancer(args: string[], env: Record<string, string>): Promise<Resultat> {
  const fin = Promise.withResolvers<Resultat>();
  const enfant = spawn("bash", args, { cwd: ROOT, env });
  let sortie = "";
  const collecter = (morceau: Buffer): void => {
    sortie += morceau.toString("utf8");
  };
  enfant.stdout.on("data", collecter);
  enfant.stderr.on("data", collecter);
  enfant.on("error", fin.reject);
  enfant.on("close", (code) => fin.resolve({ code, sortie }));
  return fin.promise;
}

const lancerContrat = (env: Record<string, string>): Promise<Resultat> =>
  lancer(["scripts/mem0-http-contrat.sh", "--run"], envEnfant(env));

function ecouter(serveur: http.Server, port = 0): Promise<number> {
  const pret = Promise.withResolvers<number>();
  serveur.once("error", pret.reject);
  serveur.listen(port, "127.0.0.1", () => pret.resolve((serveur.address() as AddressInfo).port));
  return pret.promise;
}

function fermer(serveur: http.Server): Promise<void> {
  const ferme = Promise.withResolvers<void>();
  serveur.close(() => ferme.resolve());
  serveur.closeAllConnections();
  return ferme.promise;
}

function lireCorps(flux: http.IncomingMessage): Promise<Buffer> {
  const lu = Promise.withResolvers<Buffer>();
  const morceaux: Buffer[] = [];
  flux.on("data", (m: Buffer) => morceaux.push(m));
  flux.on("end", () => lu.resolve(Buffer.concat(morceaux)));
  flux.on("error", lu.reject);
  return lu.promise;
}

async function embeddings(url: string, texte: string): Promise<number[]> {
  const reponse = await fetch(`${url}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: texte, model: "contrat-embed" }),
  });
  assert.equal(reponse.status, 200);
  const corps = (await reponse.json()) as { data: { embedding: number[] }[] };
  assert.equal(corps.data.length, 1);
  return corps.data[0]!.embedding;
}

test("mem0-http-contrat-boite-noire/AC-3 : le faux OpenAI renvoie le même vecteur de 1024 dimensions pour le même texte, dans un run et d'un run à l'autre", async () => {
  const texte = "Constante EMBEDDING_DIMS du serveur";
  const a = await demarrerFauxOpenAI();
  let premier: number[];
  try {
    premier = await embeddings(a.url, texte);
    const second = await embeddings(a.url, texte);
    assert.equal(premier.length, DIMENSIONS);
    assert.equal(DIMENSIONS, 1024);
    assert.deepEqual(second, premier);
  } finally {
    await a.fermer();
  }
  const b = await demarrerFauxOpenAI();
  try {
    const autreRun = await embeddings(b.url, texte);
    assert.deepEqual(autreRun, premier);
    assert.deepEqual(autreRun, plonger(texte));
  } finally {
    await b.fermer();
  }
});

test("mem0-http-contrat-boite-noire/AC-15 : une URL externe est refusée sans opt-in avant toute requête, et avec opt-in dès que l'instance contient un souvenir", async () => {
  const requetes: string[] = [];
  const enregistreur = http.createServer((req, res) => {
    requetes.push(`${req.method} ${req.url}`);
    if (req.method === "GET" && req.url === "/memory/all") {
      const corps = JSON.stringify({ total: 1, results: [{ id: "x" }] });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(corps) });
      res.end(corps);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const port = await ecouter(enregistreur);
  const url = `http://127.0.0.1:${port}`;
  try {
    const sansOptIn = await lancerContrat({ MEM0_CONTRAT_URL: url });
    assert.equal(sansOptIn.code, CODES_SORTIE.refus, sansOptIn.sortie);
    assert.match(sansOptIn.sortie, /MEM0_CONTRAT_EXTERNE=1/);
    assert.deepEqual(requetes, []);

    const avecOptIn = await lancerContrat({ MEM0_CONTRAT_URL: url, MEM0_CONTRAT_EXTERNE: "1" });
    assert.equal(avecOptIn.code, CODES_SORTIE.refus, avecOptIn.sortie);
    assert.ok(avecOptIn.sortie.includes("contient déjà 1 souvenir"), avecOptIn.sortie);
    assert.deepEqual(requetes, ["GET /memory/all"]);
  } finally {
    await fermer(enregistreur);
  }
});

// ---------------------------------------------------------------------------
// Tests lourds : mem0-rs jetable derrière un proxy de ce processus
// ---------------------------------------------------------------------------

const ROUTES_FIXES: Record<string, true> = { add: true, add_procedure: true, search: true, all: true, graph: true };

/** `<MÉTHODE> <gabarit>` d'une requête, les ids remplacés par `{id}`. */
function gabarit(methode: string, url: string): string {
  const chemin = url.split("?")[0] ?? "";
  const morceaux = chemin.split("/");
  if (morceaux[1] === "memory" && morceaux.length >= 3 && ROUTES_FIXES[morceaux[2] ?? ""] !== true) {
    morceaux[2] = "{id}";
  }
  return `${methode} ${morceaux.join("/")}`;
}

/** Mutation d'une réponse JSON 2xx, par `<MÉTHODE> <gabarit>` ; `undefined` = intacte. */
type Mutation = (route: string, corps: unknown) => unknown;

type Proxy = { url: string; requetes: string[]; fermer(): Promise<void> };

async function demarrerProxy(portAmont: number, muter?: Mutation): Promise<Proxy> {
  const requetes: string[] = [];
  const serveur = http.createServer(async (req, res) => {
    const route = gabarit(req.method ?? "", req.url ?? "");
    requetes.push(route);
    const corpsRequete = await lireCorps(req);
    // `agent: false` : une connexion neuve par requête. L'amont est relancé entre
    // les phases sur le même port ; une connexion gardée vivante vers l'instance
    // arrêtée ferait échouer une requête de cas au lieu du seul sondage /health.
    const amont = http.request(
      { host: "127.0.0.1", port: portAmont, method: req.method, path: req.url, headers: req.headers, agent: false },
      async (reponse) => {
        let corps = await lireCorps(reponse);
        const statut = reponse.statusCode ?? 502;
        if (muter && statut >= 200 && statut < 300) {
          try {
            const mute = muter(route, JSON.parse(corps.toString("utf8")));
            if (mute !== undefined) corps = Buffer.from(JSON.stringify(mute), "utf8");
          } catch {
            // Corps non JSON : relayé tel quel.
          }
        }
        const entetes = { ...reponse.headers };
        delete entetes["transfer-encoding"];
        entetes["content-length"] = String(corps.length);
        res.writeHead(statut, entetes);
        res.end(corps);
      },
    );
    amont.on("error", (erreur) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`amont injoignable : ${erreur.message}`);
    });
    amont.end(corpsRequete);
  });
  const port = await ecouter(serveur);
  return { url: `http://127.0.0.1:${port}`, requetes, fermer: () => fermer(serveur) };
}

async function portLibre(): Promise<number> {
  const sonde = http.createServer();
  const port = await ecouter(sonde);
  await fermer(sonde);
  return port;
}

type RunLourd = Resultat & { requetes: string[] };

async function runLourd(muter?: Mutation): Promise<RunLourd> {
  const portAmont = await portLibre();
  const proxy = await demarrerProxy(portAmont, muter);
  try {
    const resultat = await lancerContrat({
      MEM0_CONTRAT_URL: proxy.url,
      MEM0_CONTRAT_START: `MEM0_CONTRAT_PORT=${portAmont} bash scripts/mem0-http-contrat.sh --start-rs`,
      MEM0_CONTRAT_INFER: "0",
    });
    return { ...resultat, requetes: proxy.requetes };
  } finally {
    await proxy.fermer();
  }
}

const exigeRust = (): boolean => process.env.MEM0_OMP_REQUIRE_RUST === "1";

/** Pièce manquante : échec sous MEM0_OMP_REQUIRE_RUST (CI), saut annoncé sinon. */
function manque(t: TestContext, raison: string): void {
  if (exigeRust()) assert.fail(raison);
  t.skip(raison);
}

/** Pièce manquante au run : `false` = sauté. */
function piecesPresentes(t: TestContext, run: RunLourd): boolean {
  if (run.code !== CODES_SORTIE.nonExecute) return true;
  manque(t, run.sortie.split("\n")[0] ?? "");
  return false;
}

const cargoPresent = (): boolean => spawnSync("cargo", ["--version"], { encoding: "utf8" }).status === 0;

/** UN seul `cargo build` pour les tests lourds : le binaire que vise --start-rs. */
let construction: Promise<Resultat | "cargo absent"> | undefined;

/** Binaire mem0-rs à jour ; `false` = sauté (cargo absent hors REQUIRE). */
async function binairePret(t: TestContext): Promise<boolean> {
  construction ??= cargoPresent()
    ? lancer(["-c", "cargo build --manifest-path mem0-stack/mem0-rs/Cargo.toml --locked"], envEnfant({}))
    : Promise.resolve("cargo absent");
  const build = await construction;
  if (build === "cargo absent") {
    manque(t, "cargo absent : contrat contre mem0-rs non exécuté");
    return false;
  }
  assert.equal(build.code, 0, build.sortie);
  return true;
}

/** Run sans mutation partagé par AC-2 et AC-14. */
let runPartage: Promise<RunLourd> | undefined;
const partage = (): Promise<RunLourd> => (runPartage ??= runLourd());

const NEUF_ROUTES = [
  "GET /health",
  "POST /memory/add",
  "POST /memory/add_procedure",
  "POST /memory/search",
  "GET /memory/all",
  "GET /memory/graph",
  "PUT /memory/{id}",
  "DELETE /memory/{id}",
  "GET /memory/{id}/history",
];

test("mem0-http-contrat-boite-noire/AC-2 : MEM0_CONTRAT_URL et MEM0_CONTRAT_START font viser un autre serveur, qui reçoit les 9 routes", { timeout: DELAI_LOURD }, async (t) => {
  if (DEPTH !== 0) {
    t.skip(`serveurs réels à la racine seulement (MEM0_CHECK_DEPTH=${DEPTH})`);
    return;
  }
  if (!(await binairePret(t))) return;
  const run = await partage();
  if (!piecesPresentes(t, run)) return;
  assert.equal(run.code, CODES_SORTIE.conforme, run.sortie);
  const recues = new Set(run.requetes);
  for (const route of NEUF_ROUTES) assert.ok(recues.has(route), `${route} absente des requêtes reçues par le proxy`);
});

test("mem0-http-contrat-boite-noire/AC-14 : MEM0_CONTRAT_INFER=0 annonce le groupe infer désactivé, n'en exécute aucun cas et le contrat passe", { timeout: DELAI_LOURD }, async (t) => {
  if (DEPTH !== 0) {
    t.skip(`serveurs réels à la racine seulement (MEM0_CHECK_DEPTH=${DEPTH})`);
    return;
  }
  if (!(await binairePret(t))) return;
  const run = await partage();
  if (!piecesPresentes(t, run)) return;
  assert.ok(run.sortie.includes("SKIP  ouvert/infer · groupe infer=true désactivé (MEM0_CONTRAT_INFER=0)"), run.sortie);
  assert.ok(!run.sortie.split("\n").some((ligne) => /^(PASS|FAIL) {2}ouvert\/infer · /.test(ligne)), run.sortie);
  assert.ok(run.sortie.includes("0 requête(s) chat"), run.sortie);
  assert.equal(run.code, CODES_SORTIE.conforme, run.sortie);
});

const estObjet = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Une clé ajoutée, une clé retirée, un type changé : trois routes faussées. */
const FAUSSER: Mutation = (route, corps) => {
  if (!estObjet(corps)) return undefined;
  if (route === "GET /health") return { ...corps, intrus: 1 };
  // Seulement sur une instance non vide : la requête de vacuité exige `total`.
  if (route === "GET /memory/all" && Array.isArray(corps.results) && corps.results.length > 0) {
    const { total: _retire, ...reste } = corps;
    return reste;
  }
  if (route === "POST /memory/search" && Array.isArray(corps.results)) {
    return {
      ...corps,
      results: corps.results.map((r: unknown) => (estObjet(r) && "score" in r ? { ...r, score: String(r.score) } : r)),
    };
  }
  return undefined;
};

test("mem0-http-contrat-boite-noire/AC-4 : une clé en trop, une clé manquante ou un type changé fait échouer le contrat en nommant la route et la clé", { timeout: DELAI_LOURD }, async (t) => {
  if (DEPTH !== 0) {
    t.skip(`serveurs réels à la racine seulement (MEM0_CHECK_DEPTH=${DEPTH})`);
    return;
  }
  if (!(await binairePret(t))) return;
  const run = await runLourd(FAUSSER);
  if (!piecesPresentes(t, run)) return;
  assert.equal(run.code, CODES_SORTIE.echec, run.sortie);
  assert.ok(run.sortie.includes("GET /health : clé en trop « intrus »"), run.sortie);
  assert.ok(run.sortie.includes("GET /memory/all : clé manquante « total »"), run.sortie);
  assert.ok(run.sortie.includes("POST /memory/search : type de « results[0].score » attendu number, reçu string"), run.sortie);
});
