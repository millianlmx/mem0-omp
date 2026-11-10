// L'étanchéité d'un espace (un client) : ce qui, dans la configuration de ses dépôts et autour de lui,
// le laisse encore lire, écrire ou parler hors de sa frontière. CALCULÉE à chaque lecture, jamais
// stockée : une fonction pure de la configuration, des espaces, de la connexion Atlassian de
// l'espace, de ses navigateurs et des réglages de la vigie (spaces.ts les lui donne).
//
// Chaque lacune porte un code stable, le dépôt qu'elle concerne (`null` : l'espace entier) et une
// phrase qui dit quoi faire. `sealed` : aucune lacune.
import { reservedScope } from "./config.ts";
import type { RepoConfig } from "./config.ts";
import type { RepoFilter, Space } from "./db.ts";
import type { VigieSettings } from "./vigie/desk.ts";

export const ISOLATION_CODES = [
  /** Sa portée mémoire est aussi celle d'un dépôt d'un autre espace, ou hors espace. */
  "shared_scope",
  /** Sa portée mémoire est celle du service (`corpo`, `workstation`, ou l'une d'elles suivie de `:`). */
  "reserved_scope",
  /**
   * Sans `memory.tokenEnv` : ses runners reçoivent le jeton mémoire global, qui lit toutes les portées.
   * Aussi (dépôt `null`) : le poste de l'espace, dont les jobs n'ont pas de jeton mémoire propre.
   */
  "global_memory_token",
  /** Sans compte de forge ou sans identité git propres : il parle sous le compte du service. */
  "service_forge_identity",
  /** Sans `sshKey` : il pousse avec la clé SSH du service. */
  "service_ssh_key",
  /** Des projets Jira ou un dépôt `atlassian: true`, sans connexion Atlassian de l'espace. */
  "no_atlassian",
  /** Sa connexion Atlassian lit le même site (`cloudId`) qu'une autre connexion vivante : elles se lisent l'une l'autre. */
  "shared_atlassian_site",
  /** Le poste est attendu (des identités déclarées) mais aucun navigateur n'est rattaché. */
  "no_browser",
  /** La vigie publie sur des dépôts dont aucun n'est dans l'espace. */
  "public_repo_target",
] as const;
export type IsolationCode = (typeof ISOLATION_CODES)[number];

export type IsolationGap = { code: IsolationCode; repo: string | null; text: string };
export type Isolation = { sealed: boolean; gaps: IsolationGap[] };

/** Une étape qu'il reste à faire après l'accueil d'un client : une lacune à combler, ou un branchement facultatif. */
export type OnboardStep = { code: IsolationCode | "no_repos" | "connect_atlassian" | "attach_browser"; text: string };

/** Ce que l'étanchéité lit autour d'un espace. */
export type IsolationFacts = {
  /** Les dépôts déclarés (toute la configuration : le partage d'une portée se lit face aux autres). */
  repos: readonly RepoConfig[];
  /**
   * La connexion Atlassian de L'ESPACE ; `null` : Atlassian est désactivé sur le serveur. `sharedWith` :
   * les autres connexions vivantes qui lisent le même site (même `cloudId`), nommées pour le propriétaire.
   */
  atlassian: { connected: boolean; sharedWith?: readonly string[] } | null;
  /** Les navigateurs du poste rattachés à l'espace. */
  browsers: number;
  /** Le poste de travail est activé sur le serveur (`workstation.enabled`). */
  workstation: boolean;
  vigie: Pick<VigieSettings, "mode" | "repos">;
};

/** Ce que chaque lacune par dépôt demande, dit une fois pour tous les dépôts qu'elle touche (`nextSteps`). */
const REMEDIES: Partial<Record<IsolationCode, string>> = {
  shared_scope: "Donne à chaque dépôt une portée mémoire que lui seul porte (`repos[].scope`)",
  reserved_scope: "Sors chaque dépôt de la portée mémoire réservée au service (`repos[].scope`)",
  global_memory_token: "Pose un jeton mémoire par dépôt (`repos[].memory.tokenEnv`)",
  service_forge_identity:
    "Déclare le compte de forge (`gh` ou `gitlab`) et l'identité git (`git {name, email}`) de chaque dépôt",
  service_ssh_key: "Donne sa clé de déploiement à chaque dépôt (`repos[].sshKey`)",
};

/** `a, b et c`. */
export function listed(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} et ${names.at(-1)}`;
}

/** Les lacunes d'UN dépôt de l'espace : sa mémoire, son compte de forge, son identité git, sa clé SSH. */
function repoGaps(repo: RepoConfig, space: Space, facts: IsolationFacts, named: (repo: string) => boolean) {
  const gaps: IsolationGap[] = [];
  const gap = (code: IsolationCode, text: string) => gaps.push({ code, repo: repo.name, text });
  const sharing = facts.repos.filter(
    (other) => other.name !== repo.name && other.scope === repo.scope && !space.repos.includes(other.name),
  );
  if (repo.scope !== "" && sharing.length > 0) {
    const others = sharing.filter((other) => named(other.name)).map((other) => other.name);
    const whom =
      others.length === sharing.length
        ? `${others.length > 1 ? "les dépôts" : "le dépôt"} ${listed(others)}, hors de cet espace`
        : "au moins un dépôt hors de cet espace";
    gap(
      "shared_scope",
      `Le dépôt ${repo.name} partage sa portée mémoire « ${repo.scope} » avec ${whom} : chacun lit les souvenirs de l'autre. Donne-lui une portée que lui seul porte (\`repos[].scope\`).`,
    );
  }
  if (reservedScope(repo.scope))
    gap(
      "reserved_scope",
      `Le dépôt ${repo.name} a la portée mémoire « ${repo.scope} », réservée au savoir de la boîte et au poste : ses runners les liraient. Donne-lui une portée propre (\`repos[].scope\`).`,
    );
  if (repo.memory?.tokenEnv === undefined)
    gap(
      "global_memory_token",
      `Le dépôt ${repo.name} n'a pas de jeton mémoire : ses runners reçoivent le jeton global, qui lit toutes les portées. Déclare le sien (\`repos[].memory.tokenEnv\`).`,
    );
  const account =
    repo.forge === "none" ||
    repo.gh?.configDir !== undefined ||
    repo.gh?.tokenEnv !== undefined ||
    repo.gitlab?.configDir !== undefined ||
    repo.gitlab?.tokenEnv !== undefined;
  if (!account && repo.git === undefined)
    gap(
      "service_forge_identity",
      `Le dépôt ${repo.name} parle sous le compte du service : ni compte de forge ni identité git propres. Déclare les deux (\`gh\` ou \`gitlab\` : \`configDir\` ou \`tokenEnv\` ; \`git {name, email}\`).`,
    );
  else if (!account)
    gap(
      "service_forge_identity",
      `Le dépôt ${repo.name} ouvre ses PR et ses issues sous le compte de forge du service. Déclare le sien (\`gh\` ou \`gitlab\` : \`configDir\` ou \`tokenEnv\`), ou \`"forge": "none"\` s'il n'en a pas.`,
    );
  else if (repo.git === undefined)
    gap(
      "service_forge_identity",
      `Le dépôt ${repo.name} signe ses commits de l'identité git du service. Déclare la sienne (\`git {name, email}\`).`,
    );
  // Comme `--check` (check.ts) : sans distant poussé, la clé du service ne sert pas.
  if (repo.remote !== null && repo.sshKey === null)
    gap(
      "service_ssh_key",
      `Le dépôt ${repo.name} pousse avec la clé SSH du service. Donne-lui sa clé de déploiement (\`repos[].sshKey\`).`,
    );
  return gaps;
}

/** Les lacunes de l'espace ENTIER : sa connexion Atlassian, son poste, la cible de la vigie. */
function spaceGaps(space: Space, declared: readonly RepoConfig[], facts: IsolationFacts): IsolationGap[] {
  const gaps: IsolationGap[] = [];
  const gap = (code: IsolationCode, text: string) => gaps.push({ code, repo: null, text });
  const wired = declared.filter((repo) => repo.atlassian === true).map((repo) => repo.name);
  if ((space.jiraProjects.length > 0 || wired.length > 0) && facts.atlassian?.connected !== true) {
    const why = [
      ...(space.jiraProjects.length > 0 ? [`déclare des projets Jira (${space.jiraProjects.join(", ")})`] : []),
      ...(wired.length > 0
        ? [`a ${wired.length > 1 ? "des dépôts branchés" : "un dépôt branché"} sur Atlassian (${listed(wired)})`]
        : []),
    ].join(" et ");
    gap(
      "no_atlassian",
      facts.atlassian === null
        ? `Cet espace ${why}, mais Atlassian est désactivé sur ce serveur : ses runs n'y lisent rien. Active-le (\`atlassian.enabled\`), puis connecte l'espace (\`POST /v1/atlassian/connect?space=${space.id}\`).`
        : `Cet espace ${why}, mais n'a pas de connexion Atlassian : ses runs n'y lisent rien (jamais celle d'un autre espace). Connecte-la (\`POST /v1/atlassian/connect?space=${space.id}\`).`,
    );
  }
  const sharing = facts.atlassian?.connected === true ? (facts.atlassian.sharedWith ?? []) : [];
  if (sharing.length > 0)
    gap(
      "shared_atlassian_site",
      `La connexion Atlassian de cet espace lit le même site que ${listed(sharing)} : chacune y lit les tickets et les pages de l'autre. Branche un site par client ; à défaut, déclare les projets Jira de chaque espace (\`jiraProjects\`) — \`jira_issue\` et \`jira_search\` n'en sortent plus, mais Confluence et la recherche Rovo restent communs.`,
    );
  if (space.identities.length > 0 && facts.browsers === 0)
    gap(
      "no_browser",
      `Cet espace déclare des identités pour le poste mais n'a aucun navigateur : ses demandes au poste sont refusées (jamais le navigateur d'un autre espace). Rattache-en un (\`PUT /v1/workstation/browsers/{id} {"space": "${space.id}"}\`).`,
    );
  // Les jobs du poste tournent sur un dépôt synthétique, sans `memory.tokenEnv` possible : jeton global.
  if (facts.workstation && facts.browsers > 0)
    gap(
      "global_memory_token",
      `Le poste de cet espace tourne sous le jeton mémoire global, qui lit toutes les portées : sa portée (\`workstation:${space.id}\`) et le refus de la portée globale ne sont tenus que par le plugin mémoire de ses jobs, pas par le service mémoire. Il n'existe pas encore de jeton mémoire propre au poste d'un espace : si cet espace doit être étanche, détache ses navigateurs (\`PUT /v1/workstation/browsers/{id} {"space": null}\`).`,
    );
  const publishing = facts.vigie.mode === "report" || facts.vigie.mode === "fix";
  const outside = facts.vigie.repos.filter((repo) => !space.repos.includes(repo));
  if (publishing && declared.length > 0 && outside.length > 0 && outside.length === facts.vigie.repos.length)
    gap(
      "public_repo_target",
      `La vigie ne publie que sur ${listed(outside)}, hors de cet espace : un incident né ici n'y a aucune cible. Ajoute un dépôt de l'espace à ceux de la vigie (\`PUT /v1/vigie {repos}\`), ou coupe sa publication (mode \`shadow\`).`,
    );
  return gaps;
}

/**
 * L'étanchéité de l'espace telle que `reader` la lit. Un lecteur qui voit tous les dépôts (`null`) a
 * tout : les lacunes de chaque dépôt, puis celles de l'espace entier. Un client BORNÉ n'a que les
 * lacunes des dépôts qu'il voit — ni celles de l'espace entier (Atlassian, le poste et la vigie sont
 * au propriétaire), ni le nom d'un dépôt qu'il ne voit pas — et `sealed` ne juge que celles-là.
 */
export function isolationOf(space: Space, facts: IsolationFacts, reader: RepoFilter = null): Isolation {
  const declared = facts.repos.filter((repo) => space.repos.includes(repo.name));
  const seen = (repo: string) => reader === null || reader.includes(repo);
  const gaps = [
    ...declared.filter((repo) => seen(repo.name)).flatMap((repo) => repoGaps(repo, space, facts, seen)),
    ...(reader === null ? spaceGaps(space, declared, facts) : []),
  ];
  return { sealed: gaps.length === 0, gaps };
}

/**
 * Ce qu'il reste à faire après l'accueil d'un client (`POST /v1/spaces/onboard`) : une étape par code
 * de lacune (les dépôts touchés dits ensemble), puis les branchements que rien n'exige mais qu'un
 * client a souvent — des dépôts, sa connexion Atlassian, un navigateur du poste.
 */
export function nextSteps(space: Space, isolation: Isolation, facts: IsolationFacts): OnboardStep[] {
  const steps: OnboardStep[] = [];
  if (space.repos.length === 0)
    steps.push({
      code: "no_repos",
      text: `Ajoute au moins un dépôt à l'espace (\`PUT /v1/spaces/${space.id} {repos}\`) : sans dépôt, il ne borne rien.`,
    });
  for (const code of ISOLATION_CODES) {
    const gaps = isolation.gaps.filter((gap) => gap.code === code);
    if (gaps.length === 0) continue;
    const remedy = REMEDIES[code];
    const repos = gaps.flatMap((gap) => (gap.repo === null ? [] : [gap.repo]));
    if (remedy !== undefined && repos.length > 0) steps.push({ code, text: `${remedy} : ${listed(repos)}.` });
    // Sans remède par dépôt, ou une lacune de l'espace entier sous un code de dépôt (le poste) : sa phrase.
    const whole = remedy === undefined ? gaps[0] : gaps.find((gap) => gap.repo === null);
    if (whole !== undefined) steps.push({ code, text: whole.text });
  }
  const has = (code: IsolationCode) => isolation.gaps.some((gap) => gap.code === code);
  if (facts.atlassian?.connected === false && !has("no_atlassian"))
    steps.push({
      code: "connect_atlassian",
      text: `Si ce client a un Jira ou un Confluence, connecte-le à l'espace (\`POST /v1/atlassian/connect?space=${space.id}\`).`,
    });
  if (facts.workstation && facts.browsers === 0 && !has("no_browser"))
    steps.push({
      code: "attach_browser",
      text: `Si tu travailles pour ce client depuis un navigateur, rattache-le à l'espace (\`PUT /v1/workstation/browsers/{id} {"space": "${space.id}"}\`).`,
    });
  return steps;
}
