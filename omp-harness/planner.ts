// Le planificateur de /project : les modules touchés par chaque feature décident de
// l'ordre — les features disjointes partent en parallèle, celles qui se chevauchent
// sont sérialisées jusqu'au merge de la précédente.
//
// Un module est un chemin du dépôt (dossier ou fichier) ; deux ensembles se
// chevauchent dès qu'un chemin de l'un est préfixe d'un chemin de l'autre. Une
// feature aux modules INCONNUS chevauche tout : dans le doute, on sérialise.
import type { Memory, Oracle } from "./oracle.ts";

function normalize(module: string): string {
  return module.trim().replace(/^\.\//, "").replace(/\/+$/, "");
}

function contains(parent: string, child: string): boolean {
  return parent === child || child.startsWith(`${parent}/`);
}

/** Deux ensembles de modules se chevauchent-ils ? Un ensemble vide chevauche tout. */
export function overlaps(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  const left = a.map(normalize);
  const right = b.map(normalize);
  return left.some((x) => right.some((y) => x === "" || y === "" || contains(x, y) || contains(y, x)));
}

export type PlanItem = { id: string; modules: string[] };

/**
 * Les candidats qui peuvent partir MAINTENANT, dans l'ordre donné : chacun doit être
 * disjoint des actifs ET des candidats retenus avant lui (un candidat bloqué garde
 * sa place : ceux qui le chevauchent derrière lui attendent aussi, l'ordre du plan
 * tient).
 */
export function schedulable(candidates: PlanItem[], active: PlanItem[]): string[] {
  const taken: PlanItem[] = [...active];
  const started: string[] = [];
  for (const candidate of candidates) {
    const free = taken.every((other) => !overlaps(candidate.modules, other.modules));
    if (free) started.push(candidate.id);
    // Retenu ou non, il réserve ses modules pour ceux qui le suivent dans le plan.
    taken.push(candidate);
  }
  return started;
}

/**
 * Le nombre de fichiers `.ts` à partir duquel un dossier de profondeur `depth` est
 * « plat » : ses fichiers sont eux-mêmes des modules (omp-harness/*.ts), sinon deux
 * features de ce dossier se chevaucheraient toujours.
 */
export const FLAT_DIR_FILES = 8;

/**
 * Les modules connus d'un dépôt : ses dossiers jusqu'à `depth` niveaux, ses fichiers
 * de premier niveau, et les fichiers `.ts` d'un dossier plat de profondeur `depth`
 * (plus de `FLAT_DIR_FILES` fichiers `.ts` directs).
 */
export function knownModules(files: string[], depth = 2): string[] {
  const modules = new Set<string>();
  const tsByDir = new Map<string, string[]>();
  for (const file of files) {
    const parts = file.split("/");
    if (parts.length === 1) {
      modules.add(file);
      continue;
    }
    for (let level = 1; level <= Math.min(depth, parts.length - 1); level++)
      modules.add(parts.slice(0, level).join("/"));
    if (parts.length - 1 <= depth && file.endsWith(".ts")) {
      const dir = parts.slice(0, -1).join("/");
      tsByDir.set(dir, [...(tsByDir.get(dir) ?? []), file]);
    }
  }
  for (const entries of tsByDir.values()) {
    if (entries.length > FLAT_DIR_FILES) for (const file of entries) modules.add(file);
  }
  return [...modules].sort();
}

/** Les modules d'un texte : les chemins connus qu'il nomme, les plus profonds seulement. */
export function modulesFromText(text: string, known: string[]): string[] {
  const found = known.filter((module) => {
    const escaped = module.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[\\s\`'"(/])${escaped}(?=$|[\\s\`'"),:;./])`, "m").test(text);
  });
  // Un dossier nommé ET un de ses enfants : seul l'enfant est gardé (plus précis).
  return found.filter((module) => !found.some((other) => other !== module && contains(module, other))).sort();
}

/**
 * Les modules touchés d'une feature selon l'oracle : les chemins nommés par le texte
 * de la feature et par ses souvenirs de besoins (tag `besoins`) seulement — les
 * « Modules : » des autres features rappelées ne sont pas les siens.
 */
export async function modulesViaOracle(
  oracle: Oracle,
  scope: string,
  featureText: string,
  known: string[],
): Promise<{ modules: string[]; memories: Memory[] }> {
  const memories = await oracle.recall(scope, featureText, 8);
  const needs = memories.filter((memory) => memory.tags.includes("besoins"));
  const corpus = [featureText, ...needs.map((memory) => memory.text)].join("\n");
  return { modules: modulesFromText(corpus, known), memories };
}

/** La section `## Modules` d'un artefact de specs : une entrée par puce. */
export function parseModulesSection(markdown: string): string[] {
  const match = /^##\s+Modules\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(markdown);
  if (!match) return [];
  const modules: string[] = [];
  for (const line of (match[1] ?? "").split("\n")) {
    const item = /^\s*[-*]\s+`?([^`\s]+)`?/.exec(line);
    if (item) modules.push(normalize(item[1] as string));
  }
  return [...new Set(modules.filter(Boolean))];
}
