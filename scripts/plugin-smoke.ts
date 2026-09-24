// Harnais « plugins réels » (S-1) : charge CHAQUE plugin du catalogue avec le
// vrai chargeur d'OMP, vérifie l'enregistrement de ses commandes, invoque une
// commande (et, pour la mémoire, un outil) et contrôle le résultat OBSERVÉ.
//
// Pourquoi ce n'est pas un test unitaire : les tests unitaires importent
// `extension.ts` avec un faux `pi`. Ici, c'est l'hôte qui charge le plugin
// (résolution du manifeste, `registerCommand`, `registerTool`), donc une
// commande déclarée mais jamais enregistrée, un outil dont le schéma est refusé
// ou une erreur de chargement remontent pour de vrai — les trois modes de
// défaillance qu'aucun test unitaire ne peut voir.
//
// Aucune dépendance externe : le service mem0 est remplacé par un stub HTTP
// local (`Bun.serve({ port: 0 })`), donc ni conteneur, ni credential.
//
// PIÈGES MESURÉS (2026-09-24, OMP 18.2.11, Bun 1.4.0) :
//  * un spécifieur de paquet suffixé `.ts` (`@oh-my-pi/pi-coding-agent/modes/
//    runtime-init.ts`) ne résout pas et fait BLOQUER Bun indéfiniment au lieu de
//    lever — d'où les imports ABSOLUS calculés à l'exécution : le chemin de
//    l'hôte n'est connu qu'après la cascade de résolution ;
//  * `initializeExtensions` n'est pas réexporté par la racine : le spécifieur
//    exact est `<hôte>/@oh-my-pi/pi-coding-agent/src/modes/runtime-init.ts` ;
//  * sans contexte UI, le runner monte un contexte muet : `ctx.ui.notify` n'est
//    plus observable, or c'est le seul résultat visible de `/mem0-status` ;
//  * le cwd de l'extension est celui du SessionManager, jamais l'option `cwd`
//    de `createAgentSession` (le plugin voyait le cwd du process) ;
//  * `MEM0_HTTP_URL` est lue au chargement du module `mem0Client.ts` : elle doit
//    être posée AVANT de charger les extensions ;
//  * l'extension interne de l'hôte (`path === "<inline-0>"`) appelle
//    `ctx.ui.setWidget` : un stub UI qui ne le définit pas remonte un
//    `runtimeError` inoffensif mais bruyant.
//
// `MEM0_OMP_REQUIRE_SMOKE` n'est PAS lue ici : c'est `scripts/check.sh` qui
// durcit l'absence de prérequis en échec (S-2). Le harnais, lui, sort toujours
// 0 (tout est vert), 1 (au moins un échec) ou 2 (prérequis absent).
//
// Un plugin du catalogue sans vérification d'invocation connue est un ÉCHEC, pas
// un silence : AC-2 exige qu'une commande ou un outil de CHAQUE plugin soit
// invoqué. Ajouter un plugin au catalogue impose donc d'étendre INVOCATIONS.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Racine du dépôt, déduite du script (comme check.sh) — pas du cwd appelant. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// 1. Résolution de l'hôte AVANT toute autre chose
// ---------------------------------------------------------------------------
//
// L'ordre est celui de scripts/typecheck.sh:5-8, avec MEM0_OMP_HOST_MODULES en
// tête (posée par la CI). Elle doit être résolue avant de remplacer HOME, sinon
// le repli `$BUN_INSTALL` (défaut `~/.bun`) désignerait le faux HOME.
const HOME_INITIAL = process.env.HOME ?? os.homedir();

function hostCandidates(): string[] {
  const out: string[] = [];
  if (process.env.MEM0_OMP_HOST_MODULES) out.push(process.env.MEM0_OMP_HOST_MODULES);
  out.push(path.join(ROOT, "node_modules"));
  out.push(path.join(process.env.BUN_INSTALL ?? path.join(HOME_INITIAL, ".bun"), "install", "global", "node_modules"));
  return out;
}

const candidates = hostCandidates();
const host = candidates.find((dir) =>
  fs.existsSync(path.join(dir, "@oh-my-pi", "pi-coding-agent", "src", "index.ts")),
);
if (!host) {
  console.log(`✗ hôte OMP introuvable (${candidates.join(", ")})`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 2. Isolation : rien du dépôt ni de la machine n'est touché
// ---------------------------------------------------------------------------
const TMP = fs.realpathSync(os.tmpdir());
const temporaries: string[] = [];
const mktmp = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(TMP, prefix));
  temporaries.push(dir);
  return dir;
};

const home = mktmp("plugin-smoke-home-");
const project = mktmp("plugin-smoke-projet-");
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = path.join(home, ".omp", "agent");
// Sans ça, le brief mémoire s'installerait tout seul dans le dépôt de session et
// le harnais écrirait hors de ses temporaires.
process.env.MEM0_AUTOSETUP = "0";
Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: project });

// ---------------------------------------------------------------------------
// 3. Stub mem0 : la dépendance remplacée, sur un port éphémère
// ---------------------------------------------------------------------------
const hits: string[] = [];
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    hits.push(`${req.method} ${url.pathname}`);
    if (url.pathname === "/health") return Response.json({ ok: true, service: "stub" });
    if (url.pathname === "/memory/all") {
      const scope = url.searchParams.get("agent_id") ?? "";
      return Response.json(
        scope === "_global" ? [] : [{ id: "smoke-1", memory: "souvenir de fumée (fixture)" }],
      );
    }
    if (url.pathname === "/memory/search") {
      return Response.json([
        {
          id: "smoke-2",
          memory: "souvenir de recherche (fixture)",
          score_details: { semantic_score: 0.91 },
        },
      ]);
    }
    return Response.json({ ok: true });
  },
});
const STUB_URL = `http://127.0.0.1:${server.port}`;
process.env.MEM0_HTTP_URL = STUB_URL;

// ---------------------------------------------------------------------------
// 4. Chargement de l'hôte (chemins absolus, cf. pièges en tête de fichier)
// ---------------------------------------------------------------------------
// Import DYNAMIQUE assumé : le spécifieur dépend de la racine d'hôte résolue à
// l'exécution (env, ./node_modules, $BUN_INSTALL) — un import statique figerait
// un seul chemin, et le spécifieur de paquet avec `.ts` bloque Bun.
const HOST_PKG = path.join(host, "@oh-my-pi", "pi-coding-agent");
const { createAgentSession, SessionManager } = (await import(
  path.join(HOST_PKG, "src", "index.ts")
)) as {
  createAgentSession: (options: Record<string, unknown>) => Promise<{
    session: HostSession;
    extensionsResult: { extensions: Array<{ path?: string }>; errors?: unknown[] };
  }>;
  SessionManager: { inMemory: (cwd: string) => unknown };
};
const { initializeExtensions } = (await import(path.join(HOST_PKG, "src", "modes", "runtime-init.ts"))) as {
  initializeExtensions: (session: HostSession, options: Record<string, unknown>) => Promise<void>;
};

type HostSession = {
  prompt: (text: string) => Promise<boolean>;
  getToolByName?: (name: string) => HostTool | undefined;
  extensionRunner?: { getRegisteredCommands: (seen: Set<string>) => Array<{ name: string }> };
  dispose: () => Promise<void>;
};
type HostTool = {
  execute: (
    id: string,
    params: unknown,
    signal?: unknown,
    onUpdate?: unknown,
    context?: unknown,
  ) => Promise<{ content?: unknown } | undefined>;
};

// ---------------------------------------------------------------------------
// 5. Rapport
// ---------------------------------------------------------------------------
let failures = 0;
// `ok`/`bad` sont la couture de rapport : elles sont passées aux vérifications
// d'invocation (INVOCATIONS), qui ne comptent donc pas les échecs elles-mêmes.
const ok = (what: string) => {
  console.log(`  ✓ ${what}`);
};
const bad = (what: string) => {
  failures += 1;
  console.log(`  ✗ ${what}`);
};

/** Borne de temps : une invocation qui ne rend pas la main est un échec nommé. */
class Timeout extends Error {}
async function within<T>(what: string, fn: () => Promise<T>): Promise<T> {
  const bound = new Promise<never>((_, reject) => {
    AbortSignal.timeout(TIMEOUT_MS).addEventListener(
      "abort",
      () => reject(new Timeout(`${what} : plus de ${TIMEOUT_MS / 1000} s`)),
      { once: true },
    );
  });
  return await Promise.race([fn(), bound]);
}

/** Sortie 2 : prérequis absent — nettoyage fait, aucun temporaire laissé. */
function bail(what: string): never {
  server.stop(true);
  for (const dir of temporaries) fs.rmSync(dir, { recursive: true, force: true });
  console.log(`✗ ${what}`);
  process.exit(2);
}

/** Contexte UI stub : collecte les notifications, sinon le runner reste muet. */
function uiStub(notes: string[]) {
  return {
    notify: (message: string, type?: string) => notes.push(`${type ?? "info"}: ${message}`),
    setWidget: () => undefined,
    setStatus: () => undefined,
    hasOverlay: () => false,
    custom: async () => undefined,
    input: async () => undefined,
    select: async () => undefined,
    confirm: async () => false,
  } as never;
}

type Entry = { name: string; source?: unknown; commands?: string[] };
type Invocation = (ctx: {
  session: HostSession;
  notes: string[];
  ok: (what: string) => void;
  bad: (what: string) => void;
}) => Promise<void>;

/** Vérifications d'invocation : une entrée par plugin dont le harnais connaît
 *  le contrat observable. Un plugin absent de cette table échoue plus bas. */
const INVOCATIONS: Record<string, Invocation> = {
  "omp-mem0-memory": async ({ session, notes, ok, bad }) => {
    notes.length = 0;
    try {
      const handled = await within("/mem0-status", () => session.prompt("/mem0-status"));
      const text = notes.join(" | ");
      const verdict =
        !handled &&
        text.includes("ok=true") &&
        text.includes("1 souvenir(s) · global 0") &&
        text.includes(STUB_URL);
      verdict
        ? ok(`/mem0-status invoqué — « ${text} »`)
        : bad(`/mem0-status : handled=${handled}, notes=${text || "(aucune)"}`);
    } catch (error) {
      bad(`/mem0-status : ${error instanceof Error ? error.message : String(error)}`);
    }
    hits.includes("GET /health")
      ? ok(`le stub mem0 a été appelé (GET /health) sur ${STUB_URL}`)
      : bad(`le stub mem0 n'a pas été appelé (GET /health) — appels reçus : ${hits.join(", ") || "aucun"}`);

    const tool = session.getToolByName?.("mem0_search");
    if (!tool) {
      bad("outil mem0_search absent du runtime");
      return;
    }
    try {
      const result = await within("mem0_search", () =>
        tool.execute("smoke", { query: "fixture" }, undefined, undefined, undefined),
      );
      const out = JSON.stringify(result?.content ?? null);
      out.includes("souvenir de recherche (fixture)") && out.includes("[smoke-2]")
        ? ok(`mem0_search invoqué — ${out}`)
        : bad(`mem0_search : ${out}`);
    } catch (error) {
      bad(`mem0_search : ${error instanceof Error ? error.message : String(error)}`);
    }
  },

  "omp-mem0-req": async ({ session, notes, ok, bad }) => {
    notes.length = 0;
    try {
      const handled = await within("/req", () => session.prompt("/req"));
      const text = notes.join(" | ");
      !handled && text.includes("nom de feature requis")
        ? ok(`/req invoqué — « ${text} »`)
        : bad(`/req : handled=${handled}, notes=${text || "(aucune)"}`);
    } catch (error) {
      bad(`/req : ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

// ---------------------------------------------------------------------------
// 6. Une session OMP isolée par plugin
// ---------------------------------------------------------------------------
const catalogPath = path.join(ROOT, ".omp-plugin", "marketplace.json");
let catalog: { metadata?: { pluginRoot?: string }; plugins?: Entry[] };
try {
  catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as typeof catalog;
} catch (error) {
  bail(`${catalogPath} illisible : ${error instanceof Error ? error.message : String(error)}`);
}
const entries = catalog.plugins ?? [];
if (entries.length === 0) bail("catalogue vide");
const pluginRoot = catalog.metadata?.pluginRoot ?? "";

for (const entry of entries) {
  console.log(`── ${entry.name}`);
  const source = entry.source;
  if (typeof source !== "string" || !source.startsWith("./")) {
    console.log(`  · ${entry.name} : source distante, non vérifiable`);
    continue;
  }
  const dir = path.join(ROOT, pluginRoot, source.slice(2));
  const entryFile = path.join(dir, "extension.ts");
  if (!fs.existsSync(entryFile)) {
    bad(`${entryFile} introuvable — plugin non chargeable`);
    continue;
  }

  const notes: string[] = [];
  let session: HostSession | undefined;
  try {
    const created = await createAgentSession({
      cwd: project,
      additionalExtensionPaths: [entryFile],
      disableExtensionDiscovery: true,
      sessionManager: SessionManager.inMemory(project),
      enableMCP: false,
    });
    session = created.session;
    await initializeExtensions(session, {
      uiContext: uiStub(notes),
      reportSendError: () => undefined,
      reportRuntimeError: (event: { extensionPath: string; error: unknown }) => {
        if (!String(event.extensionPath).startsWith("<inline")) {
          bad(`erreur de runtime dans ${event.extensionPath} : ${String(event.error)}`);
        }
      },
    });

    const errors = created.extensionsResult.errors ?? [];
    const extensions = created.extensionsResult.extensions ?? [];
    if (errors.length > 0) {
      bad(`erreurs de chargement : ${JSON.stringify(errors)}`);
    } else {
      const mine = extensions.some((ext) => {
        const declared = typeof ext.path === "string" ? ext.path : "";
        return declared !== "" && !declared.startsWith("<inline") && path.resolve(declared) === entryFile;
      });
      mine
        ? ok(`chargé par OMP, ${extensions.length} extension(s), aucune erreur`)
        : bad(`l'extension ${entryFile} est absente du runtime (chargées : ${JSON.stringify(extensions)})`);
    }

    const declaredCommands = entry.commands ?? [];
    const registered = (session.extensionRunner?.getRegisteredCommands(new Set()) ?? []).map((c) => c.name);
    const missing = declaredCommands.filter((name) => !registered.includes(name));
    if (missing.length > 0) {
      bad(`commandes absentes du runtime : ${missing.join(", ")}`);
    } else {
      ok(`${declaredCommands.length} commande(s) du catalogue enregistrée(s)`);
    }

    // L'invocation n'a lieu QUE si l'enregistrement est vert pour la commande
    // concernée : une commande absente retomberait sur l'agent (appel modèle),
    // or la CI n'a aucun credential.
    const invocation = INVOCATIONS[entry.name];
    if (!invocation) {
      bad(`aucune vérification d'invocation connue pour ${entry.name} — étendre INVOCATIONS`);
    } else if (missing.length === 0) {
      await invocation({ session, notes, ok, bad });
    }
  } catch (error) {
    bad(`chargement impossible : ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    try {
      await session?.dispose();
    } catch {
      // Un dispose qui échoue ne change pas le verdict du plugin.
    }
  }
}

// ---------------------------------------------------------------------------
// 7. Verdict, nettoyage, sortie explicite
// ---------------------------------------------------------------------------
server.stop(true);
for (const dir of temporaries) fs.rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "Tous les plugins répondent." : `${failures} échec(s).`);
process.exit(failures === 0 ? 0 : 1);
