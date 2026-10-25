// Feature image-mem0-rs-couche-dependances : l'image de mem0-rs compile ses
// dépendances dans une couche qui ne dépend que de Cargo.toml et Cargo.lock. Une
// modification du code ne recompile plus que la crate : mesuré le 2026-10-25 sur
// 4 cœurs, la reconstruction après une ligne changée dans src/ passe de 126 s à
// 12 s, binaire identique. Lecture structurelle du Dockerfile (ordre des
// instructions de l'étape de build), sans figer ses commentaires.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../support/repo.ts";

/** Les instructions du Dockerfile, continuations `\` jointes, commentaires et lignes vides retirés. */
function instructions(file: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (current === "" && (line === "" || line.startsWith("#"))) continue;
    current += (current ? " " : "") + line.replace(/\\$/, "").trim();
    if (!line.endsWith("\\")) {
      out.push(current);
      current = "";
    }
  }
  return out;
}

/** Les instructions de l'étape `AS build`, sa ligne FROM exclue. */
function buildStage(): string[] {
  const all = instructions(path.join(ROOT, "mem0-stack", "mem0-rs", "Dockerfile"));
  const start = all.findIndex((line) => /^FROM \S+ AS build$/.test(line));
  assert.ok(start >= 0, "étape `AS build` introuvable");
  const end = all.findIndex((line, i) => i > start && line.startsWith("FROM "));
  return all.slice(start + 1, end < 0 ? undefined : end);
}

test("image-mem0-rs-couche-dependances/AC-1 : les dépendances se compilent après la seule copie de Cargo.toml et Cargo.lock, avant celle de src/", () => {
  const stage = buildStage();
  const manifests = stage.findIndex((line) => /^COPY Cargo\.toml Cargo\.lock \S+$/.test(line));
  const deps = stage.findIndex((line) => line.startsWith("RUN ") && line.includes("cargo build --release --locked"));
  const sources = stage.findIndex((line) => /^COPY src /.test(line));
  assert.ok(manifests >= 0, "COPY Cargo.toml Cargo.lock absent");
  assert.ok(deps > manifests, "la compilation des dépendances suit la copie des manifestes");
  assert.ok(sources > deps, "src/ n'est copié qu'après la couche des dépendances");
  const copies = stage.filter((line) => line.startsWith("COPY "));
  assert.ok(
    copies.indexOf(stage[manifests]!) === 0,
    "rien d'autre que les manifestes n'est copié avant la couche des dépendances",
  );
});

test("image-mem0-rs-couche-dependances/AC-2 : l'artefact du main factice est retiré, et la vraie crate est recompilée après la copie de src/", () => {
  const stage = buildStage();
  const deps = stage.find((line) => line.startsWith("RUN ") && line.includes("cargo build --release --locked"))!;
  assert.match(deps, /fn main\(\) \{\}/, "la couche des dépendances compile un main.rs vide");
  for (const artefact of ["src", "target/release/mem0-rs", "target/release/deps/mem0_rs-*"]) {
    assert.ok(deps.includes(artefact), `la couche des dépendances retire ${artefact}`);
  }
  const sources = stage.findIndex((line) => /^COPY src /.test(line));
  const final = stage.slice(sources + 1).find((line) => line.startsWith("RUN "));
  assert.ok(final, "une compilation suit la copie de src/");
  assert.match(final, /touch src\/main\.rs/, "main.rs est daté après l'artefact factice");
  assert.match(final, /cargo build --release --locked/);
});

test("image-mem0-rs-couche-dependances/AC-3 : rien de propre à BuildKit, l'image se construit pareil sous podman", () => {
  for (const line of buildStage()) {
    assert.doesNotMatch(line, /--mount=/, `instruction réservée à BuildKit : ${line}`);
  }
});
