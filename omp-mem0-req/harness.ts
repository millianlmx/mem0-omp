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

/**
 * Le code d'appairage que donne `harness.sh pair` : `omp1:` puis, en base64url, quatre
 * lignes — l'adresse du harness, son jeton, l'adresse de la mémoire partagée et son
 * jeton (ces deux dernières vides quand le serveur n'en publie pas).
 */
export type Pairing = { url: string; token: string; mem0Url: string; mem0Token: string };

/**
 * Le refus d'un code approbateur (`harness.sh approver`, une 5e ligne : le jeton qui
 * approuve les envois du poste). Il est réservé aux apps : écrit dans `~/.omp`, il
 * serait lisible par toute session omp, qui pourrait s'approuver elle-même.
 */
export const APPROVER_CODE_REFUSAL = "code des apps : utilisez `harness.sh pair`";

/** Un code ordinaire, `{ refusal }` pour un code approbateur, `null` pour un texte illisible. */
export function decodePairing(code: string): Pairing | { refusal: string } | null {
  const match = /^omp1:([A-Za-z0-9_-]+=*)$/.exec(code.trim());
  if (!match) return null;
  const [url = "", token = "", mem0Url = "", mem0Token = "", approverToken = ""] = Buffer.from(
    match[1] as string,
    "base64url",
  )
    .toString("utf8")
    .split("\n");
  if (approverToken !== "") return { refusal: APPROVER_CODE_REFUSAL };
  if (!/^https?:\/\/\S+$/.test(url) || !/^\S+$/.test(token)) return null;
  if (mem0Url !== "" && !/^https?:\/\/\S+$/.test(mem0Url)) return null;
  return { url: url.replace(/\/+$/, ""), token, mem0Url: mem0Url.replace(/\/+$/, ""), mem0Token };
}

export function encodePairing(pairing: Pairing): string {
  return `omp1:${Buffer.from([pairing.url, pairing.token, pairing.mem0Url, pairing.mem0Token].join("\n")).toString("base64url")}`;
}

/**
 * Écrit l'appairage là où le lisent le plugin, le plugin mémoire et l'app OMP Console :
 * `~/.omp/harness.json` (ses correspondances `repos` sont gardées) et
 * `~/.omp/mem0.json`, en 0600.
 */
export function writePairing(pairing: Pairing, home = os.homedir()): string[] {
  const dir = path.join(home, ".omp");
  fs.mkdirSync(dir, { recursive: true });
  let previous: HarnessFile = {};
  try {
    previous = JSON.parse(fs.readFileSync(harnessFile(home), "utf8")) as HarnessFile;
  } catch {
    /* premier appairage */
  }
  const written = [harnessFile(home)];
  fs.writeFileSync(
    written[0] as string,
    `${JSON.stringify({ ...previous, url: pairing.url, token: pairing.token }, null, 2)}\n`,
    { mode: 0o600 },
  );
  if (pairing.mem0Url !== "") {
    const memory = path.join(dir, "mem0.json");
    fs.writeFileSync(memory, `${JSON.stringify({ url: pairing.mem0Url, token: pairing.mem0Token }, null, 2)}\n`, {
      mode: 0o600,
    });
    written.push(memory);
  }
  for (const file of written) fs.chmodSync(file, 0o600);
  return written;
}

/** Une réponse non 2xx (`status` HTTP) ou un serveur injoignable (`status` 0). */
export class HarnessCallError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

export type HarnessCallOptions = {
  /** En-têtes ajoutés à l'appel (ex. `If-Match` : la révision du run lue avant un geste). */
  headers?: Record<string, string>;
  fetcher?: typeof fetch;
};

/**
 * Un appel REST ; une réponse non 2xx lève une `HarnessCallError` qui porte le statut
 * HTTP et le message d'erreur du serveur.
 */
export async function harnessCall<T>(
  target: HarnessTarget,
  method: "GET" | "POST",
  route: string,
  body?: unknown,
  options: HarnessCallOptions = {},
): Promise<T> {
  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(`${target.url}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${target.token}`,
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new HarnessCallError(
      `harness injoignable (${target.url}) : ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error =
      payload !== null && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : `HTTP ${response.status}`;
    throw new HarnessCallError(`harness : ${error}`, response.status);
  }
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

/**
 * Le résumé de la boîte de l'humain, tel que /pipelines l'affiche et que `harness_inbox`
 * le rend : chaque feature porte son id, c'est lui que prennent `harness_run` et les gestes.
 */
export function inboxSummary(inbox: Inbox, url: string): string {
  const specs = inbox.awaiting.filter((run) => run.step === "specs");
  const verdicts = inbox.awaiting.filter((run) => run.step !== "specs");
  const live = inbox.runs.filter((run) => run.state === "running" || run.state === "queued");
  const failed = inbox.runs.filter((run) => run.state === "failed");
  const proposed = inbox.audits.filter((audit) => audit.state === "proposed");
  const lines = [
    `Harness ${url}`,
    `- ${inbox.batches.length} feature(s) en escalade, ${specs.length} specs et ${verdicts.length} verdict(s) à valider, ${inbox.decisions.length} décision(s) à relire`,
    `- ${live.length} feature(s) en cours, ${failed.length} en échec, ${proposed.length} audit(s) à trier`,
    ...inbox.batches.map((batch) => `  · escalade : ${batch.run.title} [${batch.run.id}] (${batch.items.length})`),
    ...specs.map((run) => `  · specs à valider : ${run.title} [${run.id}]`),
    ...verdicts.map((run) => `  · verdict : ${run.title} [${run.id}] — ${run.reason ?? ""}`),
    ...live.map((run) => `  · ${run.title} [${run.id}] : ${run.step ? `/${run.step}` : run.state}`),
    ...failed.map((run) => `  · en échec : ${run.title} [${run.id}] — ${run.reason ?? ""}`),
    ...proposed.map(
      (audit) =>
        `  · audit ${audit.id} (${audit.focus || "dépôt entier"}) : ${audit.proposals.length} proposition(s) — /audit lancer ${audit.id} 1,2…`,
    ),
    "Les gestes se font ici quand tu les demandes en clair (harness_validate, harness_answer, harness_reverse, harness_retry, harness_cancel, harness_accept_decisions), ou dans OMP Console.",
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
