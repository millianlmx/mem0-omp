// Le client du harness (omp-harness, sur le VPS) : le seul moteur de pipelines.
//
// Le plugin ne conduit plus rien en local : /req cerne les besoins dans la session
// puis crée le run sur le serveur, /project y crée un projet, /audit y lance un
// audit, /pipelines y lit la boîte de l'humain. Tout passe par l'API REST.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type HarnessTarget = { url: string; token: string; repo: string };

type HarnessFile = { url?: string; token?: string; repos?: Record<string, string> };

/** La racine git qui contient `cwd` (dépôt ou worktree), ou `null`. */
export function gitRootOf(cwd: string): string | null {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

export function harnessFile(home = os.homedir()): string {
  return path.join(home, ".omp", "harness.json");
}

/**
 * Où et comment joindre le harness depuis `cwd` : `HARNESS_URL` / `HARNESS_TOKEN` /
 * `HARNESS_REPO`, sinon `~/.omp/harness.json` (`{url, token, repos: {<racine git>: <nom>}}`).
 * Le dépôt est le NOM déclaré côté serveur ; à défaut, le nom du dossier racine.
 */
export function resolveTarget(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
  home = os.homedir(),
): HarnessTarget | { refusal: string } {
  let file: HarnessFile = {};
  try {
    file = JSON.parse(fs.readFileSync(harnessFile(home), "utf8")) as HarnessFile;
  } catch {
    /* pas de fichier : l'environnement seul */
  }
  const url = (env.HARNESS_URL ?? file.url ?? "").replace(/\/+$/, "");
  const token = env.HARNESS_TOKEN ?? file.token ?? "";
  if (url === "" || token === "") {
    return {
      refusal: `harness non configuré : pose HARNESS_URL et HARNESS_TOKEN, ou écris ${harnessFile(home)} ({"url", "token", "repos"}).`,
    };
  }
  const root = gitRootOf(cwd);
  const repo = env.HARNESS_REPO ?? (root ? (file.repos?.[root] ?? path.basename(root)) : "");
  if (repo === "")
    return {
      refusal: `${cwd} n'est pas dans un dépôt git : pose HARNESS_REPO, le nom du dépôt déclaré sur le harness.`,
    };
  return { url, token, repo };
}

export class HarnessCallError extends Error {}

/** Un appel REST ; une réponse non 2xx lève avec le message d'erreur du serveur. */
export async function harnessCall<T>(
  target: HarnessTarget,
  method: "GET" | "POST",
  route: string,
  body?: unknown,
  fetcher: typeof fetch = fetch,
): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(`${target.url}${route}`, {
      method,
      headers: { Authorization: `Bearer ${target.token}`, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new HarnessCallError(
      `harness injoignable (${target.url}) : ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok)
    throw new HarnessCallError(
      `harness : ${typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`}`,
    );
  return payload as T;
}

type Run = { id: string; title: string; state: string; step: string | null; reason: string | null };
type Audit = {
  id: string;
  focus: string;
  state: string;
  proposals: { title: string; kind: string; rationale: string }[];
};
export type Inbox = {
  batches: { run: Run; items: unknown[] }[];
  awaiting: Run[];
  decisions: unknown[];
  runs: Run[];
  audits: Audit[];
};

/** Le résumé de la boîte de l'humain, tel que /pipelines l'affiche. */
export function inboxSummary(inbox: Inbox, url: string): string {
  const specs = inbox.awaiting.filter((run) => run.step === "specs");
  const verdicts = inbox.awaiting.filter((run) => run.step !== "specs");
  const live = inbox.runs.filter((run) => run.state === "running" || run.state === "queued");
  const proposed = inbox.audits.filter((audit) => audit.state === "proposed");
  const lines = [
    `Harness ${url}`,
    `- ${inbox.batches.length} feature(s) en escalade, ${specs.length} specs et ${verdicts.length} verdict(s) à valider, ${inbox.decisions.length} décision(s) à relire`,
    `- ${live.length} feature(s) en cours, ${proposed.length} audit(s) à trier`,
    ...inbox.batches.map((batch) => `  · escalade : ${batch.run.title} (${batch.items.length})`),
    ...specs.map((run) => `  · specs à valider : ${run.title}`),
    ...verdicts.map((run) => `  · verdict : ${run.title} — ${run.reason ?? ""}`),
    ...live.map((run) => `  · ${run.title} : ${run.step ? `/${run.step}` : run.state}`),
    ...proposed.map(
      (audit) =>
        `  · audit ${audit.id} (${audit.focus || "dépôt entier"}) : ${audit.proposals.length} proposition(s) — /audit lancer ${audit.id} 1,2…`,
    ),
    "Les gestes (réponses, validations, renversements) se font dans OMP Console, Mac ou iOS.",
  ];
  return lines.join("\n");
}

/** Les propositions d'un audit, numérotées à partir de 1 comme les tape l'utilisateur. */
export function proposalList(audit: Audit): string {
  return audit.proposals.map((p, index) => `${index + 1}. [${p.kind}] ${p.title} — ${p.rationale}`).join("\n");
}

/** `1, 3,4` → `[0, 2, 3]` ; `null` si un numéro est illisible ou hors liste. */
export function parsePicks(text: string, count: number): number[] | null {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) return null;
  const picks = parts.map(Number);
  if (picks.some((n) => !Number.isInteger(n) || n < 1 || n > count)) return null;
  return [...new Set(picks.map((n) => n - 1))];
}
