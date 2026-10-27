// `main.ts --check` : l'installation vérifiée point par point, avant le premier run.
//
// Chaque ligne dit ce qui marche, ou ce qui manque ET le geste qui le corrige. Rien
// n'est modifié : ni la base, ni les dépôts (l'écriture sur le distant est éprouvée
// par un `push --dry-run`, qui s'authentifie sans rien pousser).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HarnessConfig, RepoConfig } from "./config.ts";
import { modelChain } from "./config.ts";
import type { Git } from "./git.ts";
import { STEP_KINDS } from "./machine.ts";
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
};

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
  if (await health()) return { status: "ok", label: "mémoire (oracle)", detail: config.oracle.url };
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
    const read = await git.raw(repo.path, ["ls-remote", "--heads", repo.remote, repo.mainBranch]);
    const home = (deps.env ?? process.env).HOME ?? os.homedir();
    const key = contained ? "la clé de `harness.sh key`" : path.join(home, ".ssh", "id_ed25519.pub");
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
      const write = await git.raw(repo.path, [
        "push",
        "--dry-run",
        "--porcelain",
        repo.remote,
        `refs/heads/${repo.mainBranch}:refs/heads/omp-harness-check`,
      ]);
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
  if (repo.merge === "gh") {
    const auth = await exec("gh", ["auth", "status"], { cwd: repo.path, timeoutMs: 30_000 }).catch(() => null);
    lines.push(
      auth && auth.code === 0
        ? { status: "ok", label: label("gh"), detail: "authentifié" }
        : {
            status: "fail",
            label: label("gh"),
            detail: "gh absent ou non authentifié",
            fix: "sudo -u omp-harness -H gh auth login",
          },
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
  for (const repo of config.repos) lines.push(...(await checkRepo(repo, deps, contained)));
  return lines;
}

const MARK: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗" };

/** Le rapport lisible : une ligne par point, le geste correctif en retrait. */
export function renderChecks(lines: CheckLine[]): string {
  return lines
    .map((line) => `${MARK[line.status]} ${line.label} : ${line.detail}${line.fix ? `\n    → ${line.fix}` : ""}`)
    .join("\n");
}
