// `main.ts --check` : l'installation vérifiée point par point, avant le premier run.
//
// Chaque ligne dit ce qui marche, ou ce qui manque ET le geste qui le corrige. Rien
// n'est modifié : ni la base, ni les dépôts (l'écriture sur le distant est éprouvée
// par un `push --dry-run`, qui s'authentifie sans rien pousser).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HarnessConfig, ModelPolicy, RepoConfig } from "./config.ts";
import { modelChain } from "./config.ts";
import { openForge } from "./forge.ts";
import { remoteEnv, type Git } from "./git.ts";
import { LOCAL_PROVIDER, localProvider } from "./local-model.ts";
import { STEP_KINDS } from "./machine.ts";
import { PolicyRefusal, policyChain } from "./policy.ts";
import type { Exec } from "./proc.ts";
import { engine, memoryExtension } from "./runner.ts";

export type CheckStatus = "ok" | "warn" | "fail";

export type CheckLine = { status: CheckStatus; label: string; detail: string; fix?: string };

export type CheckDeps = {
  exec: Exec;
  git: Git;
  /** `GET /health` de l'oracle : `true` si mem0-rs répond `ok`. */
  oracleHealth: () => Promise<boolean>;
  env?: Record<string, string | undefined>;
  /** Les modèles que sert un fournisseur compatible OpenAI (`GET <base>/models`), `null` s'il ne répond pas. */
  servedModels?: (baseUrl: string) => Promise<string[] | null>;
};

/** `GET <base>/models` d'un serveur compatible OpenAI (oMLX), borné à 5 s. */
async function fetchServedModels(baseUrl: string, token: string | undefined): Promise<string[] | null> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      signal: AbortSignal.timeout(5000),
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: { id?: unknown }[] };
    return (body.data ?? []).flatMap((entry) => (typeof entry.id === "string" ? [entry.id] : []));
  } catch {
    return null;
  }
}

/**
 * La politique de modèles d'un dépôt ou du poste : chaque étape a un modèle permis
 * (sinon elle sera refusée), et en `local-only` le serveur local répond et sert ces modèles.
 */
async function checkModelPolicy(
  config: HarnessConfig,
  policy: ModelPolicy,
  label: string,
  deps: CheckDeps,
  contained: boolean,
): Promise<CheckLine[]> {
  if (policy.providers === undefined && policy.privacy !== "local-only" && policy.models === undefined) return [];
  if (policy.providers?.length === 0)
    return [
      {
        status: "fail",
        label: `${label} — modèles`,
        detail: "`providers` est vide : toute étape sera refusée",
        fix: "Nomme au moins un fournisseur permis, ou retire `providers`.",
      },
    ];
  const used = new Set<string>();
  for (const step of STEP_KINDS) {
    try {
      for (const choice of policyChain(config, policy, config.stepTiers[step], label))
        used.add(`${choice.provider}/${choice.model}`);
    } catch (err) {
      if (!(err instanceof PolicyRefusal)) throw err;
      return [
        {
          status: "fail",
          label: `${label} — modèles`,
          detail: `/${step} : ${err.message}`,
          fix: "Ajoute un modèle permis à `models` (ou un fournisseur à `providers`) pour ce tier.",
        },
      ];
    }
  }
  const lines: CheckLine[] = [
    { status: "ok", label: `${label} — modèles`, detail: [...used].join(", ") || "modèle par défaut d'omp" },
  ];
  if (policy.privacy !== "local-only") return lines;
  const local = localProvider(config);
  const fix = contained
    ? "`harness.sh local <modèle>` (oMLX lancé sur l'hôte)"
    : `main.ts --local-model ${LOCAL_PROVIDER}/<modèle> --omlx-url <url>`;
  if (local === null) {
    lines.push({
      status: "fail",
      label: `${label} — modèle local`,
      detail: `« local-only » sans fournisseur ${LOCAL_PROVIDER} déclaré aux runners`,
      fix,
    });
    return lines;
  }
  const env = deps.env ?? process.env;
  const served = await (deps.servedModels ?? ((url) => fetchServedModels(url, env.OMLX_API_TOKEN)))(local.baseUrl);
  const wanted = [...used]
    .filter((ref) => ref.startsWith(`${LOCAL_PROVIDER}/`))
    .map((ref) => ref.slice(LOCAL_PROVIDER.length + 1));
  const missing = served === null ? [] : wanted.filter((model) => !served.includes(model));
  lines.push(
    served === null
      ? { status: "fail", label: `${label} — modèle local`, detail: `${local.baseUrl}/models ne répond pas`, fix }
      : missing.length > 0
        ? {
            status: "fail",
            label: `${label} — modèle local`,
            detail: `${local.baseUrl} ne sert pas ${missing.join(", ")}`,
            fix: "Charge ce modèle dans oMLX, ou change `models` du dépôt.",
          }
        : { status: "ok", label: `${label} — modèle local`, detail: `${local.baseUrl} sert ${wanted.join(", ")}` },
  );
  return lines;
}

/** Le jeton mémoire et les comptes gh et GitLab propres au dépôt : présents là où la configuration les attend. */
function checkRepoAccounts(repo: RepoConfig, env: Record<string, string | undefined>): CheckLine[] {
  const label = (what: string) => `dépôt ${repo.name} — ${what}`;
  const lines: CheckLine[] = [];
  const memory = repo.memory?.tokenEnv;
  if (memory !== undefined)
    lines.push(
      env[memory]?.trim()
        ? { status: "ok", label: label("jeton mémoire"), detail: `${memory} (propre au dépôt)` }
        : {
            status: "fail",
            label: label("jeton mémoire"),
            detail: `${memory} est absente de l'environnement du service : aucun runner ne partira`,
            fix: `Crée un jeton mem0-rs limité à la scope du dépôt (MEM0_HTTP_TOKENS) et pose-le dans ${memory} (environnement du service).`,
          },
    );
  const host = repo.gitlab?.host ? ` --hostname ${repo.gitlab.host.replace(/^https?:\/\//, "")}` : "";
  const accounts = [
    { what: "compte gh", forge: "GitHub", account: repo.gh, login: "GH_CONFIG_DIR={dir} gh auth login" },
    {
      what: "compte GitLab",
      forge: "GitLab",
      account: repo.gitlab,
      login: `GLAB_CONFIG_DIR={dir} glab auth login${host}`,
    },
  ];
  for (const { what, forge, account, login } of accounts) {
    const token = account?.tokenEnv;
    if (token !== undefined && !env[token]?.trim())
      lines.push({
        status: "fail",
        label: label(what),
        detail: `${token} est absente de l'environnement du service`,
        fix: `Pose le jeton ${forge} du compte de ce dépôt dans ${token}.`,
      });
    const configDir = account?.configDir;
    if (configDir !== undefined && !fs.existsSync(configDir))
      lines.push({
        status: "fail",
        label: label(what),
        detail: `${configDir} n'existe pas`,
        fix: `${login.replace("{dir}", configDir)} (sous l'utilisateur du service)`,
      });
  }
  return lines;
}

/** La première ligne utile d'une sortie d'outil, pour le détail d'un échec. */
function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ?? ""
  );
}

async function checkOmp(config: HarnessConfig, exec: Exec): Promise<CheckLine> {
  // En conteneur, omp vit dans l'image des runners : c'est elle qu'on interroge.
  const line =
    config.runner.isolation === "container"
      ? engine(config, ["run", "--rm", `--entrypoint=${config.ompBin}`, config.container.runnerImage, "--version"])
      : { command: config.ompBin, args: ["--version"] };
  const where =
    config.runner.isolation === "container" ? `${config.container.runnerImage}:${config.ompBin}` : config.ompBin;
  const result = await exec(line.command, line.args, { timeoutMs: 120_000 }).catch(() => null);
  if (result && result.code === 0)
    return { status: "ok", label: "omp", detail: `${firstLine(result.stdout)} (${where})` };
  if (config.runner.isolation === "container") {
    return {
      status: "fail",
      label: "omp",
      detail: `${where} ne répond pas à --version`,
      fix: "Construis les images : `bash omp-harness/deploy/container/harness.sh up`.",
    };
  }
  return {
    status: "fail",
    label: "omp",
    detail: `${config.ompBin} ne répond pas à --version`,
    fix: "Debian : relance `sudo bash omp-harness/deploy/install.sh` (il pose omp). NixOS : `services.omp-harness.ompPackage`.",
  };
}

/** Le plugin mémoire, partie de la pile : sans lui, les runners n'ont pas `mem0_add`. */
async function checkMemoryPlugin(config: HarnessConfig, exec: Exec): Promise<CheckLine> {
  const file = memoryExtension(config);
  // En conteneur, les runners le lisent dans leur image : c'est là qu'on le cherche.
  const contained = config.runner.isolation === "container";
  const probe = engine(config, ["run", "--rm", "--entrypoint=test", config.container.runnerImage, "-f", file]);
  const found = contained
    ? (await exec(probe.command, probe.args, { timeoutMs: 120_000 }).catch(() => null))?.code === 0
    : fs.existsSync(file);
  if (found) return { status: "ok", label: "plugin mémoire", detail: file };
  return {
    status: "fail",
    label: "plugin mémoire",
    detail: `${file} introuvable${contained ? ` dans ${config.container.runnerImage}` : ""} : les agents n'auraient pas \`mem0_add\``,
    fix: contained
      ? "Reconstruis les images : `bash omp-harness/deploy/container/harness.sh up`."
      : "Installe `omp-mem0-memory` à côté de `omp-harness` (Debian : relance `sudo bash omp-harness/deploy/install.sh`).",
  };
}

async function checkEngine(config: HarnessConfig, exec: Exec): Promise<CheckLine[]> {
  const version = engine(config, ["version", "--format", "{{.Server.Version}}"]);
  const reached = await exec(version.command, version.args, { timeoutMs: 30_000 }).catch(() => null);
  if (reached?.code !== 0) {
    return [
      {
        status: "fail",
        label: "moteur de conteneurs",
        detail: `${config.container.command.join(" ")} ne joint pas son moteur${reached ? ` : ${firstLine(reached.stderr)}` : ""}`,
        fix: "Le socket du moteur doit être monté dans le service (compose.yaml) ; DOCKER_HOST le désigne s'il n'est pas à sa place.",
      },
    ];
  }
  const lines: CheckLine[] = [
    {
      status: "ok",
      label: "moteur de conteneurs",
      detail: `${config.container.command.join(" ")} ${firstLine(reached.stdout)}`,
    },
  ];
  const images = [
    config.container.runnerImage,
    config.container.testImage,
    ...config.repos.flatMap((repo) => (repo.testImage ? [repo.testImage] : [])),
  ];
  for (const image of [...new Set(images)]) {
    const inspect = engine(config, ["image", "inspect", "--format", "{{.Id}}", image]);
    const found = await exec(inspect.command, inspect.args, { timeoutMs: 30_000 }).catch(() => null);
    lines.push(
      found && found.code === 0
        ? { status: "ok", label: `image ${image}`, detail: "présente" }
        : {
            status: "fail",
            label: `image ${image}`,
            detail: "absente",
            fix: `Tire-la (\`${config.container.command.join(" ")} pull ${image}\`), ou construis les images locales : \`harness.sh up\`.`,
          },
    );
  }
  return lines;
}

function checkLauncher(config: HarnessConfig): CheckLine | null {
  if (config.runner.isolation !== "systemd" && config.heavy.isolation !== "systemd") return null;
  const missing = [config.launcher[0], config.launcher.at(-1)].filter(
    (file): file is string => !!file && !fs.existsSync(file),
  );
  if (missing.length === 0 && config.launcher.length > 0)
    return { status: "ok", label: "lanceur root", detail: config.launcher.join(" ") };
  return {
    status: "fail",
    label: "lanceur root",
    detail:
      missing.length > 0
        ? `introuvable : ${missing.join(", ")}`
        : "`launcher` est vide alors que l'isolation est systemd",
    fix: "Relance `deploy/install.sh` (Debian) ou `nixos-rebuild switch` (NixOS).",
  };
}

function checkModels(config: HarnessConfig): CheckLine {
  const bare = STEP_KINDS.filter((step) => modelChain(config, config.stepTiers[step]).length === 0);
  if (bare.length === 0) {
    const tiers = STEP_KINDS.map((step) => `${step} ${config.stepTiers[step]}`).join(", ");
    return { status: "ok", label: "modèles", detail: tiers };
  }
  return {
    status: "warn",
    label: "modèles",
    detail: `aucun modèle pour ${bare.map((step) => `/${step}`).join(", ")} : omp y prendra son modèle par défaut`,
    fix: "Renseigne `models.standard` et `models.heavy` dans la configuration du harness.",
  };
}

async function checkOracle(config: HarnessConfig, health: () => Promise<boolean>): Promise<CheckLine> {
  if (!config.oracle)
    return {
      status: "warn",
      label: "mémoire (oracle)",
      detail: "aucun oracle : les runs tournent sans la mémoire du projet",
    };
  // Seule la santé est sondée : les écritures perdues se comptent dans le service (GET /v1/status).
  if (await health())
    return {
      status: "ok",
      label: "mémoire (oracle)",
      detail: `${config.oracle.url} répond ; écritures perdues : GET /v1/status`,
    };
  return {
    status: "fail",
    label: "mémoire (oracle)",
    detail: `${config.oracle.url}/health ne répond pas ok`,
    fix:
      config.runner.isolation === "container"
        ? "`harness.sh logs` ; OMLX_BASE_URL dans ~/.omp-harness-secrets/mem0.env doit joindre le serveur d'embeddings."
        : "`systemctl status omp-harness-mem0` ; OMLX_BASE_URL dans /etc/omp-harness/mem0.env doit joindre le homelab.",
  };
}

function checkToken(config: HarnessConfig, env: Record<string, string | undefined>): CheckLine {
  if (env.HARNESS_TOKEN) return { status: "ok", label: "jeton d'API", detail: "HARNESS_TOKEN" };
  if (fs.existsSync(config.tokenFile)) return { status: "ok", label: "jeton d'API", detail: config.tokenFile };
  return {
    status: "warn",
    label: "jeton d'API",
    detail: `${config.tokenFile} sera créé au premier démarrage du service`,
  };
}

async function checkRepo(repo: RepoConfig, deps: CheckDeps, contained: boolean): Promise<CheckLine[]> {
  const { git, exec } = deps;
  const label = (what: string) => `dépôt ${repo.name} — ${what}`;
  const main = await git
    .raw(repo.path, ["rev-parse", "--verify", "--quiet", `refs/heads/${repo.mainBranch}^{commit}`])
    .catch(() => null);
  if (main?.code !== 0) {
    return [
      {
        status: "fail",
        label: label("clone"),
        detail: `${repo.path} : pas de branche ${repo.mainBranch}`,
        fix: contained
          ? `harness.sh add <url> ${repo.name}`
          : `sudo -u omp-harness git clone --bare <url> ${repo.path}`,
      },
    ];
  }
  const lines: CheckLine[] = [{ status: "ok", label: label("clone"), detail: `${repo.path} (${repo.mainBranch})` }];
  if (repo.remote === null) {
    lines.push({ status: "warn", label: label("distant"), detail: "`remote: null` : les merges restent sur ce VPS" });
  } else {
    const env = deps.env ?? process.env;
    const sshEnv = remoteEnv(repo, env);
    const read = await git.raw(repo.path, ["ls-remote", "--heads", repo.remote, repo.mainBranch], sshEnv);
    const key =
      repo.sshKey !== null
        ? `${repo.sshKey}.pub${contained ? ` (\`harness.sh key ${repo.name}\`)` : ""}`
        : contained
          ? "la clé de `harness.sh key`"
          : path.join(env.HOME ?? os.homedir(), ".ssh", "id_ed25519.pub");
    const keyFix = `Ajoute ${key} comme clé de déploiement AVEC écriture sur le dépôt.`;
    if (read.code !== 0) {
      lines.push({
        status: "fail",
        label: label(`lecture de ${repo.remote}`),
        detail: firstLine(read.stderr) || `code ${read.code}`,
        fix: keyFix,
      });
    } else {
      // Une ref neuve en essai : l'authentification en écriture est éprouvée, rien n'est poussé.
      const write = await git.raw(
        repo.path,
        ["push", "--dry-run", "--porcelain", repo.remote, `refs/heads/${repo.mainBranch}:refs/heads/omp-harness-check`],
        sshEnv,
      );
      lines.push(
        write.code === 0
          ? { status: "ok", label: label(`écriture sur ${repo.remote}`), detail: "authentifiée (essai à blanc)" }
          : {
              status: "fail",
              label: label(`écriture sur ${repo.remote}`),
              detail: firstLine(write.stderr) || `code ${write.code}`,
              fix: keyFix,
            },
      );
    }
  }
  // La CLI de la forge, pour les dépôts qui s'en servent : PR (`merge: "gh"`), ou un compte
  // ou une forge déclarés. Sous le compte du dépôt ; un jeton absent est déjà signalé (checkRepoAccounts).
  if (repo.merge === "gh" || repo.gh !== undefined || repo.gitlab !== undefined || (repo.forge ?? "none") !== "none") {
    const forge = await openForge(repo, { exec, git, env: deps.env ?? process.env });
    const auth = await forge.auth().catch(() => null);
    const cli = label(forge.kind === "gitlab" ? "glab" : forge.kind === "github" ? "gh" : "forge");
    if (auth !== null)
      lines.push(
        auth.ok
          ? { status: "ok", label: cli, detail: auth.detail }
          : { status: "fail", label: cli, detail: auth.detail, fix: auth.fix },
      );
  }
  return lines;
}

/** Toutes les vérifications, dans l'ordre où un humain les corrige. */
export async function runChecks(config: HarnessConfig, deps: CheckDeps): Promise<CheckLine[]> {
  const contained = config.runner.isolation === "container" || config.heavy.isolation === "container";
  const lines: CheckLine[] = contained ? await checkEngine(config, deps.exec) : [];
  lines.push(await checkOmp(config, deps.exec), await checkMemoryPlugin(config, deps.exec));
  const launcher = checkLauncher(config);
  if (launcher) lines.push(launcher);
  lines.push(
    checkModels(config),
    await checkOracle(config, deps.oracleHealth),
    checkToken(config, deps.env ?? process.env),
  );
  if (config.repos.length === 0) {
    const fix = contained
      ? "`harness.sh add git@github.com:<toi>/<dépôt>.git`"
      : "Ajoute une entrée à `repos` dans la configuration du harness.";
    lines.push({ status: "fail", label: "dépôts", detail: "aucun dépôt déclaré", fix });
  }
  for (const repo of config.repos)
    lines.push(
      ...(await checkRepo(repo, deps, contained)),
      ...checkRepoAccounts(repo, deps.env ?? process.env),
      ...(await checkModelPolicy(config, repo, `dépôt ${repo.name}`, deps, contained)),
    );
  if (config.workstation.enabled && config.workstation.policy)
    lines.push(...(await checkModelPolicy(config, config.workstation.policy, "poste de travail", deps, contained)));
  // GitHub refuse une même clé de déploiement sur deux dépôts : la clé du service n'en sert qu'un.
  const shared = config.repos.filter((repo) => repo.remote !== null && repo.sshKey === null).map((repo) => repo.name);
  if (shared.length >= 2)
    lines.push({
      status: "warn",
      label: "clés de déploiement",
      detail: `${shared.join(", ")} partagent la clé du service, que GitHub n'accepte que sur un dépôt`,
      fix: contained
        ? "Donne à chacun sa clé : retire son entrée de config.json, puis `harness.sh add <url> <nom>` (ou relance le service `repos` de la pile)."
        : `Donne à chacun sa clé : \`sudo -u omp-harness ssh-keygen -q -t ed25519 -N '' -C omp-harness:<nom> -f ${path.join((deps.env ?? process.env).HOME ?? os.homedir(), ".ssh", "repos", "<nom>")}\`, puis \`"sshKey"\` sur son entrée de la configuration.`,
    });
  return lines;
}

const MARK: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗" };

/** Le rapport lisible : une ligne par point, le geste correctif en retrait. */
export function renderChecks(lines: CheckLine[]): string {
  return lines
    .map((line) => `${MARK[line.status]} ${line.label} : ${line.detail}${line.fix ? `\n    → ${line.fix}` : ""}`)
    .join("\n");
}
