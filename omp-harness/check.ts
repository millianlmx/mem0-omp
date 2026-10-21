// `main.ts --check` : l'installation vérifiée point par point, avant le premier run.
//
// Chaque ligne dit ce qui marche, ou ce qui manque ET le geste qui le corrige. Rien
// n'est modifié : ni la base, ni les dépôts (l'écriture sur le distant est éprouvée
// par un `push --dry-run`, qui s'authentifie sans rien pousser).
import * as fs from "node:fs";
import type { HarnessConfig, RepoConfig } from "./config.ts";
import { modelChain } from "./config.ts";
import type { Git } from "./git.ts";
import { STEP_KINDS } from "./machine.ts";
import type { Exec } from "./proc.ts";


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
  return text.split("\n").map(line => line.trim()).find(line => line !== "") ?? "";
}


async function checkOmp(config: HarnessConfig, exec: Exec): Promise<CheckLine> {
  const result = await exec(config.ompBin, ["--version"], { timeoutMs: 30_000 }).catch(() => null);
  if (result && result.code === 0) return { status: "ok", label: "omp", detail: `${firstLine(result.stdout)} (${config.ompBin})` };
  return {
    status: "fail",
    label: "omp",
    detail: `${config.ompBin} ne répond pas à --version`,
    fix: "Debian : relance `sudo bash omp-harness/deploy/install.sh` (il pose omp). NixOS : `services.omp-harness.ompPackage`.",
  };
}


function checkLauncher(config: HarnessConfig): CheckLine | null {
  if (config.runner.isolation !== "systemd" && config.heavy.isolation !== "systemd") return null;
  const missing = [config.launcher[0], config.launcher.at(-1)].filter((file): file is string => !!file && !fs.existsSync(file));
  if (missing.length === 0 && config.launcher.length > 0) return { status: "ok", label: "lanceur root", detail: config.launcher.join(" ") };
  return {
    status: "fail",
    label: "lanceur root",
    detail: missing.length > 0 ? `introuvable : ${missing.join(", ")}` : "`launcher` est vide alors que l'isolation est systemd",
    fix: "Relance `deploy/install.sh` (Debian) ou `nixos-rebuild switch` (NixOS).",
  };
}


function checkModels(config: HarnessConfig): CheckLine {
  const bare = STEP_KINDS.filter(step => modelChain(config, config.stepTiers[step]).length === 0);
  if (bare.length === 0) {
    const tiers = STEP_KINDS.map(step => `${step} ${config.stepTiers[step]}`).join(", ");
    return { status: "ok", label: "modèles", detail: tiers };
  }
  return {
    status: "warn",
    label: "modèles",
    detail: `aucun modèle pour ${bare.map(step => `/${step}`).join(", ")} : omp y prendra son modèle par défaut`,
    fix: "Renseigne `models.standard` et `models.heavy` dans /etc/omp-harness/config.json.",
  };
}


async function checkOracle(config: HarnessConfig, health: () => Promise<boolean>): Promise<CheckLine> {
  if (!config.oracle) return { status: "warn", label: "mémoire (oracle)", detail: "aucun oracle : les runs tournent sans la mémoire du projet" };
  if (await health()) return { status: "ok", label: "mémoire (oracle)", detail: config.oracle.url };
  return {
    status: "fail",
    label: "mémoire (oracle)",
    detail: `${config.oracle.url}/health ne répond pas ok`,
    fix: "`systemctl status omp-harness-mem0` ; OMLX_BASE_URL dans /etc/omp-harness/mem0.env doit joindre le homelab.",
  };
}


function checkToken(config: HarnessConfig, env: Record<string, string | undefined>): CheckLine {
  if (env.HARNESS_TOKEN) return { status: "ok", label: "jeton d'API", detail: "HARNESS_TOKEN" };
  if (fs.existsSync(config.tokenFile)) return { status: "ok", label: "jeton d'API", detail: config.tokenFile };
  return { status: "warn", label: "jeton d'API", detail: `${config.tokenFile} sera créé au premier démarrage du service` };
}


async function checkRepo(repo: RepoConfig, deps: CheckDeps): Promise<CheckLine[]> {
  const { git, exec } = deps;
  const label = (what: string) => `dépôt ${repo.name} — ${what}`;
  const main = await git.raw(repo.path, ["rev-parse", "--verify", "--quiet", `refs/heads/${repo.mainBranch}^{commit}`]).catch(() => null);
  if (!main || main.code !== 0) {
    return [
      {
        status: "fail",
        label: label("clone"),
        detail: `${repo.path} : pas de branche ${repo.mainBranch}`,
        fix: `sudo -u omp-harness git clone --bare <url> ${repo.path}`,
      },
    ];
  }
  const lines: CheckLine[] = [{ status: "ok", label: label("clone"), detail: `${repo.path} (${repo.mainBranch})` }];
  if (repo.remote === null) {
    lines.push({ status: "warn", label: label("distant"), detail: "`remote: null` : les merges restent sur ce VPS" });
  } else {
    const read = await git.raw(repo.path, ["ls-remote", "--heads", repo.remote, repo.mainBranch]);
    const keyFix = "Ajoute /var/lib/omp-harness/.ssh/id_ed25519.pub comme clé de déploiement AVEC écriture sur le dépôt.";
    if (read.code !== 0) {
      lines.push({ status: "fail", label: label(`lecture de ${repo.remote}`), detail: firstLine(read.stderr) || `code ${read.code}`, fix: keyFix });
    } else {
      // Une ref neuve en essai : l'authentification en écriture est éprouvée, rien n'est poussé.
      const write = await git.raw(repo.path, ["push", "--dry-run", "--porcelain", repo.remote, `refs/heads/${repo.mainBranch}:refs/heads/omp-harness-check`]);
      lines.push(
        write.code === 0
          ? { status: "ok", label: label(`écriture sur ${repo.remote}`), detail: "authentifiée (essai à blanc)" }
          : { status: "fail", label: label(`écriture sur ${repo.remote}`), detail: firstLine(write.stderr) || `code ${write.code}`, fix: keyFix },
      );
    }
  }
  if (repo.merge === "gh") {
    const auth = await exec("gh", ["auth", "status"], { cwd: repo.path, timeoutMs: 30_000 }).catch(() => null);
    lines.push(
      auth && auth.code === 0
        ? { status: "ok", label: label("gh"), detail: "authentifié" }
        : { status: "fail", label: label("gh"), detail: "gh absent ou non authentifié", fix: "sudo -u omp-harness -H gh auth login" },
    );
  }
  return lines;
}


/** Toutes les vérifications, dans l'ordre où un humain les corrige. */
export async function runChecks(config: HarnessConfig, deps: CheckDeps): Promise<CheckLine[]> {
  const lines: CheckLine[] = [await checkOmp(config, deps.exec)];
  const launcher = checkLauncher(config);
  if (launcher) lines.push(launcher);
  lines.push(checkModels(config), await checkOracle(config, deps.oracleHealth), checkToken(config, deps.env ?? process.env));
  if (config.repos.length === 0) {
    lines.push({ status: "fail", label: "dépôts", detail: "aucun dépôt déclaré", fix: "Ajoute une entrée à `repos` dans /etc/omp-harness/config.json." });
  }
  for (const repo of config.repos) lines.push(...(await checkRepo(repo, deps)));
  return lines;
}


const MARK: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗" };

/** Le rapport lisible : une ligne par point, le geste correctif en retrait. */
export function renderChecks(lines: CheckLine[]): string {
  return lines.map(line => `${MARK[line.status]} ${line.label} : ${line.detail}${line.fix ? `\n    → ${line.fix}` : ""}`).join("\n");
}
