// Les outils qu'un dépôt attend dans le shell de ses agents (`repos[].tools`), cherchés là
// où les runners tournent : un conteneur jetable de l'image des runners en isolation
// `container`, le PATH du service sinon (`none`, et `systemd`, dont les runners partagent
// les binaires de l'hôte). Un outil absent n'est pas contourné en silence : l'étape
// s'arrête et le run attend l'humain (steps.ts, machine.ts `tools`).
import type { HarnessConfig, RepoConfig } from "../config/config.ts";
import type { Exec } from "./proc.ts";
import { containerUser, engine } from "./runner.ts";

/** Les noms en arguments, un par absent sur stdout : aucun nom n'est interprété par le shell. */
const PROBE = 'for tool; do command -v "$tool" >/dev/null 2>&1 || echo "$tool"; done';
const PROBE_TIMEOUT_MS = 60_000;

/** Le geste qui lève l'absence : l'outil installé là où les runners tournent, ou retiré du dépôt. */
export function toolsFix(config: HarnessConfig, repo: RepoConfig): string {
  const where =
    config.runner.isolation === "container"
      ? `l'image des runners (\`container.runnerImage\` : ${config.container.runnerImage})`
      : "le PATH des runners";
  return `Installe-les dans ${where}, ou retire-les de \`repos.${repo.name}.tools\`, puis relance le run.`;
}

/** L'étape s'arrête faute d'outils : la relancer telle quelle referait le même constat. */
export class MissingTools extends Error {
  constructor(config: HarnessConfig, repo: RepoConfig, tools: string[]) {
    super(`outils absents des runners : ${tools.join(", ")} — ${toolsFix(config, repo)}`);
  }
}

/**
 * Les outils de `repos[].tools` introuvables par les runners, `[]` s'il n'en manque aucun.
 * `null` : la recherche elle-même a échoué (moteur injoignable, image absente) — le
 * lancement du runner le dira mieux qu'elle.
 */
export async function missingTools(config: HarnessConfig, exec: Exec, repo: RepoConfig): Promise<string[] | null> {
  const tools = repo.tools ?? [];
  if (tools.length === 0) return [];
  const argv =
    config.runner.isolation === "container"
      ? engine(config, [
          "run",
          "--rm",
          "--log-driver=none",
          "--network=none",
          `--user=${containerUser(config)}`,
          "--entrypoint=sh",
          config.container.runnerImage,
          "-c",
          PROBE,
          "sh",
          ...tools,
        ])
      : { command: "sh", args: ["-c", PROBE, "sh", ...tools] };
  const result = await exec(argv.command, argv.args, { timeoutMs: PROBE_TIMEOUT_MS }).catch(() => null);
  if (result === null || result.code !== 0) return null;
  const absent = new Set(result.stdout.split("\n").map((line) => line.trim()));
  return tools.filter((tool) => absent.has(tool));
}
