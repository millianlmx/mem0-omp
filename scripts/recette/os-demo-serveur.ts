// Le serveur de DÉMONSTRATION de la nouvelle interface (« OS agentique ») : le monde de
// `mac-shots-serveur.ts` (une revue à valider avec ses preuves, une question à carte) plus ce que
// la nouvelle interface montre. Les runs vivants sont conduits par le VRAI orchestrateur et le
// faux runner : une feature livrée seule de bout en bout, une feature au travail dont l'intention
// change en direct, une feature en file retenue par les modules de la précédente. S'y ajoutent un
// échec à relancer, un arrêt avec son motif, un audit proposé, deux espaces, des consignes
// permanentes et une session omp locale qui bat.
//
// Sortie : UNE ligne JSON `{url, token, runId, runs}` sur stdout, puis le serveur tourne jusqu'à
// SIGTERM/SIGINT. Usage : `node --experimental-strip-types scripts/recette/os-demo-serveur.ts`.
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { Client } from "../../omp-harness/auth.ts";
import { repoDefaults } from "../../omp-harness/config.ts";
import { createHandler } from "../../omp-harness/http.ts";
import { ConfigAdmin } from "../../omp-harness/repos.ts";
import { OK, type FakeWorld, fakeWorld, harnessRepo, waitFor } from "../../test/support/harness-fixtures.ts";
import { DEMO_RUN, GRAPH_RUN, demoWorld } from "./mac-shots-serveur.ts";

/** Le second dépôt : celui d'un client, dans son propre espace. */
export const CLIENT_REPO = "acme-web";
export const LOCAL_SESSION = "demo-session-locale";

const ACTOR = { by: "demo" };
const OWNER: Client = { name: "demo", role: "admin", repos: "*", createdAt: 0, approver: true, pilot: false };

/** Ce que fait l'agent au travail, tour à tour : une intention toutes les huit secondes, une heure durant. */
const INTENTS: readonly [tool: string, intent: string][] = [
  ["read", "Lisant les routes des commandes"],
  ["grep", "Cherchant les usages du statut"],
  ["edit", "Ajoutant le filtre par statut"],
  ["bash", "Lançant les tests du filtre"],
  ["edit", "Corrigeant le cas « statut inconnu »"],
];

function liveImpl(): Record<string, unknown>[] {
  const actions: Record<string, unknown>[] = [{ tool: "progress", args: { message: "routes lues, filtre à écrire" } }];
  for (let turn = 0; turn < 450; turn++) {
    const [toolName, intent] = INTENTS[turn % INTENTS.length] as [string, string];
    actions.push(
      { frame: { type: "tool_execution_start", toolCallId: `demo-${turn}`, toolName, args: {}, intent } },
      { sleep: 8000 },
    );
  }
  return actions;
}

/** Ce que rapporte la session locale, tour à tour. */
const LOCAL_INTENTS: readonly [tool: string, intent: string][] = [
  ["read", "Lisant le formulaire d'inscription"],
  ["edit", "Validant l'adresse de courriel"],
  ["bash", "Lançant les tests d'accessibilité"],
];

/** Ce qu'une feature a dépensé à une étape : le coût du jour, de l'espace et du brief en vivent. */
function spend(world: FakeWorld, runId: string, repo: string, step: string, cost: number): void {
  world.store.addUsage({
    runId,
    auditId: null,
    repo,
    step,
    provider: "demo",
    model: "modele-demo",
    input: Math.round(cost * 40_000),
    output: Math.round(cost * 6_000),
    cacheRead: 0,
    cacheWrite: 0,
    cost,
  });
}

/** Les objets posés tels quels : un échec, un arrêt motivé, un audit proposé, les espaces et les consignes. */
function seed(world: FakeWorld): void {
  const { store, orchestrator } = world;
  // Une feature arrêtée sur une question tient ses modules : sans modules elle tiendrait tout le dépôt,
  // et plus rien n'y partirait.
  store.updateRun(GRAPH_RUN, { modules: ["src/factures", "src/courriel"] });
  // La revue attend l'humain pour la taille de son diff : la raison que la machine écrit, et que les vues relisent.
  store.updateRun(DEMO_RUN, {
    modules: ["src/panier.ts"],
    reason: "validation humaine : diff de 412 lignes au-delà de review.maxDiffLines (300)",
  });
  store.createRun({
    id: "demo-echec",
    repo: CLIENT_REPO,
    slug: "mot-de-passe-oublie",
    title: "Page de connexion : mot de passe oublié",
    request: "Ajouter le lien « mot de passe oublié » et l'envoi du courriel de réinitialisation.",
    branch: "harness/mot-de-passe-oublie",
    state: "failed",
    step: "impl",
    reason: "étape /impl en échec : le fournisseur de modèles a coupé la session (2 tentatives)",
  });
  store.createRun({
    id: "demo-arret",
    repo: CLIENT_REPO,
    slug: "refonte-tableau-de-bord",
    title: "Refonte complète du tableau de bord",
    request: "Refaire le tableau de bord avec les nouveaux graphiques.",
    branch: "harness/refonte-tableau-de-bord",
    state: "cancelled",
    step: "specs",
  });
  store.updateRun("demo-arret", {
    cancelCause: "too_big",
    reason: "annulé par l'humain : trop gros — à découper en trois features",
  });
  spend(world, DEMO_RUN, "demo", "review", 2.31);
  spend(world, GRAPH_RUN, "demo", "impl", 0.64);
  spend(world, "demo-echec", CLIENT_REPO, "impl", 0.87);
  spend(world, "demo-arret", CLIENT_REPO, "specs", 0.12);
  // Une documentation validée à la main puis fusionnée : le serveur en tire une proposition de palier.
  store.createRun({
    id: "demo-guide",
    repo: "demo",
    slug: "guide-installation",
    title: "Mettre à jour le guide d'installation",
    request: "Décrire l'installation sur un poste neuf.",
    branch: "harness/guide-installation",
    state: "merged",
    kind: "docs",
  });
  store.appendEvent("validation", "demo-guide", { gate: "verdict", approve: true, liftable: true });
  store.createAudit({ id: "demo-audit", repo: CLIENT_REPO, focus: "Accessibilité des formulaires" });
  store.updateAuditIf("demo-audit", ["queued"], {
    state: "proposed",
    proposals: [
      {
        title: "Libellés associés à chaque champ",
        request: "Associer un libellé à chaque champ des formulaires d'inscription et de connexion.",
        modules: ["src/api"],
        kind: "faiblesse",
        rationale: "Trois champs n'ont qu'un texte d'exemple : un lecteur d'écran ne les nomme pas.",
        evidence: ["src/api/routes.ts"],
        dependsOn: [],
        impact: "high",
        effort: "low",
      },
      {
        title: "Erreurs de saisie annoncées",
        request: "Annoncer les erreurs de saisie au lecteur d'écran dès qu'elles apparaissent.",
        modules: ["src/api"],
        kind: "feature",
        rationale: "Les erreurs n'apparaissent qu'en rouge, sans annonce.",
        evidence: ["src/api/routes.ts"],
        dependsOn: [0],
        impact: "medium",
        effort: "medium",
      },
    ],
  });
  const perso = orchestrator.spaces.create(
    { name: "Perso", repos: ["demo"], jiraProjects: [], dailyBudgetUsd: 20, autonomy: null },
    ACTOR,
  );
  // L'espace « Perso » a le poste : un navigateur lui est rattaché (`poste` se déduit des navigateurs).
  store.touchWorkstationBrowser({ id: "demo-chrome", label: "Chrome perso", version: null, at: Date.now() });
  store.setWorkstationBrowserSpace("demo-chrome", perso.id);
  orchestrator.spaces.create(
    {
      name: "Client Acme",
      repos: [CLIENT_REPO],
      jiraProjects: ["ACME"],
      dailyBudgetUsd: 50,
      autonomy: "ask",
    },
    ACTOR,
  );
  orchestrator.standing.create(
    {
      text: "Les messages d'erreur visibles sont en français, sans jargon technique.",
      repo: null,
      source: "manual",
      sourceRunId: null,
    },
    ACTOR,
  );
  orchestrator.standing.create(
    {
      text: "Quand la question « Quel format pour les dates exportées ? » se pose : ISO 8601.",
      repo: "demo",
      source: "answer",
      sourceRunId: GRAPH_RUN,
    },
    ACTOR,
  );
  orchestrator.standing.create(
    {
      text: "Jamais de nouvelle dépendance sans la nommer dans les specs.",
      repo: CLIENT_REPO,
      source: "correction",
      sourceRunId: "demo-arret",
    },
    ACTOR,
  );
}

/** Le monde de démonstration de la nouvelle interface, orchestrateur démarré ; rend aussi les runs conduits. */
export async function osDemoWorld(): Promise<{
  world: FakeWorld;
  runs: { delivered: string; working: string; blocked: string };
  stop: () => Promise<void>;
}> {
  const world = demoWorld(
    fakeWorld(
      { req: [OK.req], specs: [OK.specs], impl: [OK.impl, liveImpl()], review: [OK.review] },
      {
        patch: (config) => {
          const first = config.repos[0];
          if (!first) throw new Error("monde de test sans dépôt");
          // Une règle de palier (les bogues : specs validées seules) et un apprentissage qui propose vite.
          first.autonomy = {
            rules: [
              {
                match: { kind: "bug", maxDiffLines: 80 },
                require: { reproTest: true, greenChecks: true },
                gates: { specs: "auto", review: "human" },
              },
            ],
          };
          config.autonomyLearning.minRuns = 1;
          config.repos.push(
            repoDefaults({
              name: CLIENT_REPO,
              path: harnessRepo("harness-acme-"),
              scope: "acme-scope",
              tests: first.tests,
            }),
          );
        },
      },
    ),
  );
  seed(world);
  const { orchestrator, store } = world;
  await orchestrator.start();
  // La première feature va de /req au merge sans aucun geste : elle est « livrée seule ».
  const delivered = orchestrator.createRun(
    {
      repo: "demo",
      title: "Exporter les commandes en CSV",
      request: "Exporter la liste des commandes au format CSV.",
      // Des modules précis : une feature sans modules tient tout le dépôt, et la question ouverte la retiendrait.
      modules: ["src/api"],
    },
    ACTOR,
  );
  await waitFor(
    () => store.getRun(delivered.id)?.state === "merged",
    () => `la feature livrée n'est pas fusionnée (état ${store.getRun(delivered.id)?.state})`,
    90_000,
  );
  // La suivante s'arrête dans /impl (le faux runner y passe une heure) : elle est « au travail ».
  const working = orchestrator.createRun(
    {
      repo: "demo",
      title: "Filtrer les commandes par statut",
      request: "Filtrer la liste des commandes par statut (payée, expédiée, annulée).",
      kind: "feature",
      modules: ["src/api"],
    },
    ACTOR,
  );
  await waitFor(
    () => {
      const run = store.getRun(working.id);
      return run?.state === "running" && run.step === "impl";
    },
    () => `la feature au travail n'est pas en /impl (état ${store.getRun(working.id)?.state})`,
    90_000,
  );
  // Celle-ci touche les mêmes modules : elle reste en file, retenue par la précédente.
  const blocked = orchestrator.createRun(
    {
      repo: "demo",
      title: "Trier les commandes par date",
      request: "Trier la liste des commandes par date de création.",
      modules: ["src/api"],
    },
    ACTOR,
  );
  spend(world, delivered.id, "demo", "impl", 0.42);
  spend(world, working.id, "demo", "impl", 1.18);
  let turn = 0;
  const beat = () => {
    const [tool, intent] = LOCAL_INTENTS[turn % LOCAL_INTENTS.length] as [string, string];
    turn += 1;
    orchestrator.localSessions.beat(
      {
        id: LOCAL_SESSION,
        host: "MacBook-Pro",
        cwd: `/Users/demo/Projets/${CLIENT_REPO}`,
        remote: `git@github.com:demo/${CLIENT_REPO}.git`,
        branch: "feat/inscription",
        title: "Refonte du formulaire d'inscription",
        state: "working",
        intent,
        tool,
        model: "claude-sonnet",
        cost: 1.84 + turn * 0.02,
      },
      OWNER,
    );
  };
  beat();
  const timer = setInterval(beat, 20_000);
  return {
    world,
    runs: { delivered: delivered.id, working: working.id, blocked: blocked.id },
    stop: async () => {
      clearInterval(timer);
      await orchestrator.stop();
    },
  };
}

if (import.meta.main) {
  const { world, runs, stop } = await osDemoWorld();
  const token = randomBytes(32).toString("hex");
  // Le fichier de configuration du monde, écrit tel qu'il sert : l'écran Dépôts le lit et le règle.
  const configFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "os-demo-config-")), "config.json");
  const { dataDir, worktreesDir, repos } = world.config;
  fs.writeFileSync(configFile, `${JSON.stringify({ dataDir, worktreesDir, repos }, null, 2)}\n`);
  const admin = new ConfigAdmin(configFile, world.orchestrator, { git: world.deps.git });
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, token, admin }));
  server.listen(Number(process.env.OS_DEMO_PORT ?? 0), "127.0.0.1", () => {
    const { port } = server.address() as AddressInfo;
    process.stdout.write(
      `${JSON.stringify({ url: `http://127.0.0.1:${port}`, token, runId: DEMO_RUN, runs: { ...runs, review: DEMO_RUN, question: GRAPH_RUN } })}\n`,
    );
  });
  const end = () => {
    server.closeAllConnections();
    server.close(() => {
      void stop().finally(() => process.exit(0));
    });
  };
  process.on("SIGTERM", end);
  process.on("SIGINT", end);
}
