// Garde du bloc « ## Installation » de README.md : trois voies dans l'ordre app
// OMP Console < pile conteneur à la main < plugins, aucune commande podman
// ou docker dans la voie de l'app ni dans celle des plugins (ni l'une ni l'autre
// n'exige de moteur de conteneurs ; le serveur, lui, peut en utiliser un), et la
// pile jamais redite « obligatoire ».
// Seul le bloc est lu : `podman` et « obligatoire » restent permis ailleurs dans
// le README. La garde est éprouvée par des copies mutées construites depuis le
// README réel, jamais depuis un texte en dur.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../support/repo.ts";

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

type VoieKind = "app" | "manuelle" | "plugins" | "autre";
type Voie = { kind: VoieKind; heading: string; text: string };

const VOIE_KINDS = ["app", "manuelle", "plugins"] as const;

/** Lignes entre `## Installation` et le titre `## ` suivant (exclu) ; null sans titre. */
function installationBlock(readme: string): string | null {
  const lines = readme.split("\n");
  const start = lines.findIndex((line) => line.trim() === "## Installation");
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

function voieKind(heading: string): VoieKind {
  if (heading.includes("OMP Console")) return "app";
  if (heading.includes("pile conteneur")) return "manuelle";
  if (heading.includes("Les plugins")) return "plugins";
  return "autre";
}

/** Préambule (kind `autre`), puis un segment par titre `### `, titre compris. */
function voies(block: string): Voie[] {
  const segments: Voie[] = [];
  let current = { kind: "autre" as VoieKind, heading: "", lines: [] as string[] };
  for (const line of block.split("\n")) {
    if (line.startsWith("### ")) {
      segments.push({ kind: current.kind, heading: current.heading, text: current.lines.join("\n") });
      current = { kind: voieKind(line), heading: line, lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  segments.push({ kind: current.kind, heading: current.heading, text: current.lines.join("\n") });
  return segments;
}

/** Violations de la règle du bloc Installation ; liste vide = vert. */
function installationViolations(readme: string): string[] {
  const block = installationBlock(readme);
  if (block === null) return ["section « Installation » absente"];
  const violations: string[] = [];
  const segments = voies(block);

  for (const kind of VOIE_KINDS) {
    const count = segments.filter((segment) => segment.kind === kind).length;
    if (count === 0) violations.push(`voie ${kind} absente`);
    else if (count > 1) violations.push(`voie ${kind} en double`);
  }

  const ordered = segments.filter((segment) => segment.kind !== "autre").map((segment) => segment.kind);
  const single = VOIE_KINDS.every((kind) => ordered.filter((k) => k === kind).length === 1);
  if (single) {
    const ranks = VOIE_KINDS.map((kind) => ordered.indexOf(kind));
    if (!(ranks[0] < ranks[1] && ranks[1] < ranks[2])) {
      violations.push(`ordre des voies rompu : ${ordered.join(", ")}`);
    }
  }

  for (const line of block.split("\n")) {
    if (/obligatoire/i.test(line)) {
      violations.push(`« obligatoire » dans la section Installation : ${line.trim()}`);
    }
  }

  for (const segment of segments) {
    if (segment.kind !== "app" && segment.kind !== "plugins") continue;
    for (const line of segment.text.split("\n")) {
      for (const match of line.matchAll(/\b(podman|docker)\b/gi)) {
        violations.push(`${match[1].toLowerCase()} dans la voie ${segment.kind} : ${line.trim()}`);
      }
    }
  }

  return violations;
}

const readme = read("README.md");
const lines = readme.split("\n");

function requireBlock(): string {
  const block = installationBlock(readme);
  assert.ok(block !== null, "README.md sans section « ## Installation »");
  return block;
}

function voie(kind: VoieKind): Voie {
  const found = voies(requireBlock()).filter((segment) => segment.kind === kind);
  assert.equal(found.length, 1, `voie ${kind} : ${found.length} segment(s)`);
  return found[0];
}

/** Index dans `lines` du titre `### ` de la voie `kind`, cherché dans le bloc Installation. */
function headingIndex(kind: VoieKind): number {
  const start = lines.findIndex((line) => line.trim() === "## Installation");
  assert.notEqual(start, -1, "README.md sans section « ## Installation »");
  for (let i = start + 1; i < lines.length && !lines[i].startsWith("## "); i++) {
    if (lines[i].startsWith("### ") && voieKind(lines[i]) === kind) return i;
  }
  assert.fail(`titre de la voie ${kind} introuvable dans le bloc Installation`);
}

const insertAfter = (index: number, line: string) =>
  [...lines.slice(0, index + 1), line, ...lines.slice(index + 1)].join("\n");

test("readme-installation-podman-contradiction/AC-1 : trois voies dans l'ordre app, manuelle, plugins, sans « obligatoire »", () => {
  const block = requireBlock();
  assert.deepEqual(
    voies(block)
      .filter((segment) => segment.kind !== "autre")
      .map((segment) => segment.kind),
    ["app", "manuelle", "plugins"],
  );
  assert.doesNotMatch(block, /obligatoire/i);
});

test("readme-installation-podman-contradiction/AC-2 : la voie app ne porte aucune commande de service et renvoie à omp-console/README.md", () => {
  const app = voie("app").text;
  assert.doesNotMatch(app, /podman|docker|compose|doctor\.sh|\.env\b/i);
  for (const needle of ["omp-console/README.md", "n'installe pas les plugins", "« Les plugins dans omp »"]) {
    assert.ok(app.includes(needle), `voie app sans « ${needle} »`);
  }
});

test("readme-installation-podman-contradiction/AC-3 : la voie manuelle garde clone, podman/docker, doctor.sh et migration", () => {
  const manuelle = voie("manuelle").text;
  for (const needle of [
    // Assemblée, jamais littérale : docs/AC-21 recense les fichiers porteurs de l'URL du dépôt.
    ["git clone https://github", "com/millianlmx/mem0-omp"].join("."),
    "podman compose up -d",
    "docker compose up -d",
    "doctor.sh",
    "mem0-stack/README.md#migrer-une-pile-mem0-http-existante",
  ]) {
    assert.ok(manuelle.includes(needle), `voie manuelle sans « ${needle} »`);
  }
});

test("readme-installation-podman-contradiction/AC-4 : la voie plugins garde marketplace, CLI, install.sh, service joignable et mode dégradé", () => {
  const plugins = voie("plugins").text;
  for (const needle of [
    "/marketplace add millianlmx/mem0-omp",
    "install omp-mem0-memory@mem0-omp",
    "install omp-mem0-req@mem0-omp",
    "relance `omp`",
    "omp plugin install",
    "--scope project",
    "omp-mem0-memory/install.sh",
    "rien à faire par projet",
    "déjà joignable",
    "Aucun service",
    "se dégrade proprement",
  ]) {
    assert.ok(plugins.includes(needle), `voie plugins sans « ${needle} »`);
  }
  assert.ok(requireBlock().includes("PUBLISHING.md"), "section Installation sans renvoi vers PUBLISHING.md");
});

test("readme-installation-podman-contradiction/AC-7 : la garde est verte sur le README livré", () => {
  assert.deepEqual(installationViolations(readme), []);
});

test("readme-installation-podman-contradiction/AC-8 : voie manuelle remise avant l'app, ou pile redite « obligatoire » : la garde rougit", () => {
  const ia = headingIndex("app");
  const im = headingIndex("manuelle");
  const ip = headingIndex("plugins");

  const swapped = [...lines.slice(0, ia), ...lines.slice(im, ip), ...lines.slice(ia, im), ...lines.slice(ip)].join(
    "\n",
  );
  assert.notEqual(swapped, readme);
  const swappedViolations = installationViolations(swapped);
  assert.ok(
    swappedViolations.some((violation) => /^ordre des voies rompu/.test(violation)),
    `violations : ${JSON.stringify(swappedViolations)}`,
  );

  const mandatory = insertAfter(im, "La pile conteneur est obligatoire.");
  const mandatoryViolations = installationViolations(mandatory);
  assert.ok(
    mandatoryViolations.some((violation) => /^« obligatoire »/.test(violation)),
    `violations : ${JSON.stringify(mandatoryViolations)}`,
  );
});

test("readme-installation-podman-contradiction/AC-9 : podman ou docker compose dans la voie app ou plugins : la garde rougit", () => {
  const inApp = installationViolations(insertAfter(headingIndex("app"), "podman compose up -d"));
  assert.ok(
    inApp.some((violation) => /^podman dans la voie app/.test(violation)),
    `violations : ${JSON.stringify(inApp)}`,
  );

  const inPlugins = installationViolations(insertAfter(headingIndex("plugins"), "docker compose up -d"));
  assert.ok(
    inPlugins.some((violation) => /^docker dans la voie plugins/.test(violation)),
    `violations : ${JSON.stringify(inPlugins)}`,
  );
});

test("readme-installation-podman-contradiction/AC-10 : podman compose up -d hors du bloc Installation : la garde reste verte", () => {
  const start = lines.findIndex((line) => line.trim() === "## Installation");
  assert.notEqual(start, -1, "README.md sans section « ## Installation »");
  const next = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  assert.notEqual(next, -1, "aucun titre `## ` après « ## Installation »");

  const before = [...lines.slice(0, start), "podman compose up -d", ...lines.slice(start)].join("\n");
  const after = insertAfter(next, "podman compose up -d");
  for (const copy of [before, after]) {
    assert.notEqual(copy, readme);
    assert.deepEqual(installationViolations(copy), []);
  }
});
