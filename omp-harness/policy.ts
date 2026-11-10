// La politique par dépôt (et celle des jobs du poste) : chez quels fournisseurs ses
// prompts partent, sous quelle identité ses commits s'écrivent, avec quel compte GitHub
// `gh` parle pour lui et quel jeton mémoire ses runners reçoivent.
//
// Tout est facultatif : un dépôt sans ces champs garde le comportement du serveur
// (chaînes globales, `config.git`, la connexion gh du service, le jeton mémoire global).
// Quand un champ est posé, il est appliqué en ÉCHEC FERMÉ : une liste blanche vide
// pour un tier refuse l'étape (jamais de repli sur un autre fournisseur), un jeton
// déclaré mais absent de l'environnement refuse le runner ou l'appel gh (jamais de
// repli sur le jeton global).
//
// Un ESPACE (un client, spaces.ts) peut porter sa propre politique de modèles : elle se croise
// avec celle de chacun de ses dépôts, au plus strict (`strictest`). Un dépôt hors de tout espace,
// ou d'un espace sans politique, garde exactement la sienne.
import * as fs from "node:fs";
import * as path from "node:path";
import type { HarnessConfig, ModelChoice, ModelPolicy, RepoConfig, Tier } from "./config.ts";
import { MODEL_REF, TIERS } from "./config.ts";
import { HarnessError } from "./errors.ts";
import type { GitIdentity } from "./git.ts";
import { LOCAL_PROVIDER, localProvider } from "./local-model.ts";
import type { Space } from "./db.ts";

/** Une étape (ou un appel) que la politique d'un dépôt interdit : jamais relancée telle quelle. */
export class PolicyRefusal extends HarnessError {
  constructor(message: string) {
    super(409, message);
  }
}

/** Les jetons GitHub que `gh` lit, du plus prioritaire au moins prioritaire. */
export const GH_TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"] as const;

/** Les jetons GitLab que `glab` lit (`GITLAB_TOKEN` d'abord). */
export const GITLAB_TOKEN_VARS = ["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN"] as const;

/** Un jeton mémoire tel que mem0-rs l'accepte dans `MEM0_HTTP_TOKENS` (ni `:`, ni `;`, ni espace). */
const MEMORY_TOKEN = /^[A-Za-z0-9._~+/=-]{16,512}$/;

/**
 * La chaîne de bascule d'un tier sous une politique : pour chaque tier, du demandé vers
 * le plus capable, la chaîne propre (`models`) sinon celle du serveur, filtrée par la
 * liste blanche (`providers`) et par `local-only` (le seul fournisseur local) ; la
 * première non vide gagne. En `local-only`, les modèles que sert le fournisseur local
 * des runners (`--local-model`) viennent en dernier recours.
 *
 * Sans liste blanche ni `local-only`, une chaîne vide rend `[]` (le modèle par défaut
 * d'omp, comme avant). Avec, elle lève `PolicyRefusal` : aucun modèle hors de la liste.
 */
export function policyChain(
  config: HarnessConfig,
  policy: ModelPolicy,
  tier: Tier,
  owner: string,
  served: () => readonly string[] = () => localProvider(config)?.models ?? [],
): ModelChoice[] {
  const localOnly = policy.privacy === "local-only";
  const allowed = (choice: ModelChoice) =>
    (!localOnly || choice.provider === LOCAL_PROVIDER) && (policy.providers?.includes(choice.provider) ?? true);
  for (const candidate of TIERS.slice(TIERS.indexOf(tier))) {
    const own = (policy.models?.[candidate] ?? []).flatMap((ref) => {
      const match = MODEL_REF.exec(ref);
      return match ? [{ provider: match[1] as string, model: match[2] as string }] : [];
    });
    const chain = (own.length > 0 ? own : config.models[candidate]).filter(allowed);
    if (chain.length > 0) return chain;
  }
  if (localOnly) {
    const local = served()
      .map((model) => ({ provider: LOCAL_PROVIDER, model }))
      .filter(allowed);
    if (local.length > 0) return local;
    throw new PolicyRefusal(
      `${owner} est « local-only » et aucun modèle local n'est permis pour le tier ${tier} : déclare-en un (\`harness.sh local <modèle>\`, ou \`models.${tier}: ["${LOCAL_PROVIDER}/<modèle>"]\`) — rien ne part chez un fournisseur distant`,
    );
  }
  if (policy.providers !== undefined)
    throw new PolicyRefusal(
      `${owner} : aucun modèle du tier ${tier} (ni au-dessus) chez ses fournisseurs permis (${policy.providers.join(", ") || "liste vide"}) — l'étape ne bascule jamais hors de la liste`,
    );
  return [];
}

/**
 * La politique `own` (un dépôt, une Demande, un job du poste) croisée avec celle de son espace, au
 * plus STRICT, en échec fermé : `local-only` l'emporte dès que l'un des deux le pose ; les listes
 * blanches se croisent (une intersection vide reste une liste VIDE : `policyChain` refuse, jamais de
 * repli) ; les chaînes propres s'enchaînent tier par tier, celle de `own` d'abord, celle de l'espace
 * ensuite — toutes passent ensuite par la liste blanche et `local-only` croisés. Sans politique
 * d'espace (`null`), `own` est rendue telle quelle : rien ne change hors d'un espace.
 */
export function strictest(own: ModelPolicy, space: ModelPolicy | null): ModelPolicy {
  if (space === null) return own;
  const providers =
    own.providers === undefined || space.providers === undefined
      ? (own.providers ?? space.providers)
      : own.providers.filter((name) => space.providers?.includes(name));
  const models: Partial<Record<Tier, string[]>> = {};
  for (const tier of TIERS) {
    const chain = [...new Set([...(own.models?.[tier] ?? []), ...(space.models?.[tier] ?? [])])];
    if (chain.length > 0) models[tier] = chain;
  }
  const privacy = own.privacy === "local-only" || space.privacy === "local-only" ? "local-only" : own.privacy;
  return {
    ...(Object.keys(models).length > 0 ? { models } : {}),
    ...(providers !== undefined ? { providers } : {}),
    ...(privacy !== undefined ? { privacy } : {}),
  };
}

/** L'espace d'un dépôt quand il porte une politique de modèles : son nom (pour le dire) et elle ; sinon `null`. */
export function spaceRule(
  spaces: readonly Pick<Space, "name" | "repos" | "policy">[],
  repo: string,
): { space: string; policy: ModelPolicy } | null {
  const space = spaces.find((candidate) => candidate.repos.includes(repo));
  return space?.policy ? { space: space.name, policy: space.policy } : null;
}

/**
 * Ce que borne la politique de modèles EN VIGUEUR d'un dépôt — la sienne croisée avec celle de son
 * espace (`strictest`) : « local-only » et sa liste blanche de fournisseurs ; `null` quand elle ne borne
 * rien. C'est ce que `GET /v1/repos` rend (`policy`) : un client qui n'a pas la configuration (la vigie)
 * sait ainsi ce qu'il ne doit pas envoyer à son propre modèle.
 */
export function policyBounds(
  repo: RepoConfig,
  spaces: readonly Pick<Space, "name" | "repos" | "policy">[],
): Pick<ModelPolicy, "privacy" | "providers"> | null {
  const { privacy, providers } = strictest(repo, spaceRule(spaces, repo.name)?.policy ?? null);
  if (privacy === undefined && providers === undefined) return null;
  return { ...(privacy !== undefined ? { privacy } : {}), ...(providers !== undefined ? { providers } : {}) };
}

/** `dir` est `root` ou se trouve dessous. */
function within(dir: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), dir);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * L'identité git d'un geste, selon le lieu où il s'écrit (`place` : le clone, son
 * dossier git, ou un worktree du dépôt sous `worktreesDir/<nom>`) : celle du dépôt
 * s'il en déclare une, sinon `config.git`. Lue à chaque geste : un rechargement compte.
 */
export function repoIdentity(config: HarnessConfig): (place: string) => GitIdentity {
  return (place) => {
    const dir = path.resolve(place);
    const repo = config.repos.find(
      (candidate) =>
        candidate.git !== undefined &&
        (within(dir, candidate.path) || within(dir, path.join(config.worktreesDir, candidate.name))),
    );
    return repo?.git ? { authorName: repo.git.name, authorEmail: repo.git.email } : config.git;
  };
}

/**
 * L'environnement d'un `gh` pour un dépôt : `undefined` sans compte propre (celui du
 * service, hérité). Avec `configDir`, sa connexion (`GH_CONFIG_DIR`) ; avec `tokenEnv`,
 * le jeton de cette variable en `GH_TOKEN`. Les jetons du service sont retirés : `gh`
 * les préfère à toute connexion, l'appel partirait sous le mauvais compte.
 */
export function ghEnv(
  repo: RepoConfig,
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> | undefined {
  const gh = repo.gh;
  if (gh?.configDir === undefined && gh?.tokenEnv === undefined) return undefined;
  const out: Record<string, string | undefined> = { ...env };
  for (const key of GH_TOKEN_VARS) delete out[key];
  if (gh.configDir !== undefined) out.GH_CONFIG_DIR = gh.configDir;
  if (gh.tokenEnv !== undefined) {
    const token = env[gh.tokenEnv]?.trim();
    if (!token)
      throw new PolicyRefusal(
        `dépôt ${repo.name} : ${gh.tokenEnv} (son jeton GitHub) est absente de l'environnement du service — aucun appel gh sous un autre compte`,
      );
    out.GH_TOKEN = token;
  }
  return out;
}

/**
 * L'environnement d'un `glab` pour un dépôt : toujours l'instance (`GITLAB_HOST`) et sans
 * question interactive. Avec `gitlab.configDir`, sa connexion (`GLAB_CONFIG_DIR`) ; avec
 * `gitlab.tokenEnv`, le jeton de cette variable en `GITLAB_TOKEN`. Dès qu'un compte est
 * propre au dépôt, les jetons GitLab du service sont retirés, comme pour `gh`.
 */
export function glabEnv(
  repo: RepoConfig,
  host: string,
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env, GITLAB_HOST: host, GLAB_NO_PROMPT: "1" };
  const gitlab = repo.gitlab;
  if (gitlab?.configDir === undefined && gitlab?.tokenEnv === undefined) return out;
  for (const key of GITLAB_TOKEN_VARS) delete out[key];
  if (gitlab.configDir !== undefined) out.GLAB_CONFIG_DIR = gitlab.configDir;
  if (gitlab.tokenEnv !== undefined) {
    const token = env[gitlab.tokenEnv]?.trim();
    if (!token)
      throw new PolicyRefusal(
        `dépôt ${repo.name} : ${gitlab.tokenEnv} (son jeton GitLab) est absente de l'environnement du service — aucun appel glab sous un autre compte`,
      );
    out.GITLAB_TOKEN = token;
  }
  return out;
}

/**
 * Le jeton mémoire propre au dépôt, ou `null` (le jeton global). Déclaré mais absent ou
 * illisible : refus — le jeton global ouvrirait la mémoire de tous les projets.
 */
export function repoMemoryToken(
  repo: RepoConfig,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const name = repo.memory?.tokenEnv;
  if (name === undefined) return null;
  const token = env[name]?.trim() ?? "";
  if (token === "")
    throw new PolicyRefusal(
      `dépôt ${repo.name} : ${name} (son jeton mémoire) est absente de l'environnement du service — aucun runner avec le jeton global`,
    );
  if (!MEMORY_TOKEN.test(token))
    throw new PolicyRefusal(
      `dépôt ${repo.name} : ${name} n'est pas un jeton mémoire lisible (16 à 512 caractères parmi A-Z a-z 0-9 . _ ~ + / = -)`,
    );
  return token;
}

/** Le fichier du jeton mémoire d'un dépôt, que le lanceur root et le conteneur d'un runner lisent. */
export function memoryTokenFile(config: HarnessConfig, repoName: string): string {
  return path.join(path.dirname(config.providersEnvFile), "memory-tokens", `${repoName}.env`);
}

/**
 * Pose (0600, atomique) ou retire le fichier du jeton mémoire d'un dépôt avant un
 * runner : un jeton retiré de la configuration ne survit pas dans un vieux fichier.
 * Rend le chemin écrit, ou `null`.
 */
export function syncMemoryTokenFile(config: HarnessConfig, repoName: string, token: string | null): string | null {
  const file = memoryTokenFile(config, repoName);
  if (token === null) {
    fs.rmSync(file, { force: true });
    return null;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `MEM0_HTTP_TOKEN=${token}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  return file;
}

/** Les variables du service qui portent un jeton propre à un dépôt : aucun runner ne les voit. */
export function policySecretVars(config: HarnessConfig): string[] {
  return [
    ...new Set(
      config.repos.flatMap((repo) =>
        [repo.gh?.tokenEnv, repo.gitlab?.tokenEnv, repo.memory?.tokenEnv].filter((name) => name !== undefined),
      ),
    ),
  ];
}
