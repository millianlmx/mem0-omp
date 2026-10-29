// Construit l'extension Chrome omp-chrome/ sans aucune dépendance (appelé par
// scripts/chrome-extension.sh) :
//   1. chaque `omp-chrome/src/**/*.ts` (hors `.d.ts`) devient `<sortie>/**/*.js` par
//      `stripTypeScriptTypes` de `node:module` en mode `strip` — les sources n'emploient
//      que de la syntaxe effaçable (`erasableSyntaxOnly`, `import type`) ;
//   2. les spécificateurs relatifs `./x.ts` sont réécrits en `./x.js` (les sources
//      importent en `.ts` pour node --test et tsc ; Chrome charge les `.js`) ;
//   3. HTML et CSS sont copiés, `manifest.json` aussi — sa `version` est celle de
//      omp-chrome/package.json, la seule que le job de release monte —, et les icônes
//      PNG sont dessinées ;
//   4. le résultat est vérifié : chaque fichier que cite le manifeste existe, chaque
//      import relatif d'un `.js` désigne un fichier construit, aucun `.ts` n'y survit.
// Toute faute sort 1 avec une ligne `✗ …` ; rien n'est laissé à moitié écrit dans la sortie.

import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXTENSION = path.join(ROOT, "omp-chrome");
const SOURCES = path.join(EXTENSION, "src");

const COPIED: Record<string, true> = { ".html": true, ".css": true };
/** `from "./x.ts"`, `import "./x.ts"`, `import("./x.ts")` : les trois formes d'un import relatif. */
const RELATIVE_TS = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"'\n]+?)\.ts\2/g;
const RELATIVE_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"'\n]+?)\1/g;

class BuildError extends Error {}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue; // .DS_Store du Finder, fichiers d'éditeur
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out.sort();
}

/** Un bloc PNG : longueur, type, données, puis le CRC-32 du type et des données. */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** L'icône : un disque bleu (#2f6fde) percé d'un point blanc, lissé par suréchantillonnage 4×4. */
function icon(size: number): Buffer {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const center = size / 2;
  const outer = size * 0.46;
  const inner = size * 0.17;
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filtre « aucun »
    for (let x = 0; x < size; x++) {
      let disc = 0;
      let dot = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const d = Math.hypot(x + (sx + 0.5) / 4 - center, y + (sy + 0.5) / 4 - center);
          if (d <= outer) disc++;
          if (d <= inner) dot++;
        }
      }
      const white = dot / 16;
      const offset = row + 1 + x * 4;
      raw[offset] = Math.round(0x2f + (0xff - 0x2f) * white);
      raw[offset + 1] = Math.round(0x6f + (0xff - 0x6f) * white);
      raw[offset + 2] = Math.round(0xde + (0xff - 0xde) * white);
      raw[offset + 3] = Math.round((255 * disc) / 16);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8 bits, RVBA, compression, filtre, non entrelacé
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

type Manifest = {
  background?: { service_worker?: string };
  options_ui?: { page?: string };
  action?: { default_popup?: string; default_icon?: Record<string, string> };
  icons?: Record<string, string>;
  content_scripts?: { js?: string[]; css?: string[] }[];
  web_accessible_resources?: { resources?: string[] }[];
};

/** Les fichiers que le manifeste cite nommément (les motifs de web_accessible_resources à part). */
function manifestFiles(manifest: Manifest): string[] {
  return [
    manifest.background?.service_worker,
    manifest.options_ui?.page,
    manifest.action?.default_popup,
    ...Object.values(manifest.action?.default_icon ?? {}),
    ...Object.values(manifest.icons ?? {}),
    ...(manifest.content_scripts ?? []).flatMap((script) => [...(script.js ?? []), ...(script.css ?? [])]),
  ].filter((file): file is string => typeof file === "string");
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}

/** Vérifie la construction `dir`, dont `files` liste les chemins relatifs (séparateur `/`). */
function verify(dir: string, files: readonly string[]): void {
  const manifest: Manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  for (const file of manifestFiles(manifest)) {
    if (!files.includes(file)) throw new BuildError(`le manifeste cite ${file}, absent de la sortie`);
  }
  for (const entry of manifest.web_accessible_resources ?? []) {
    for (const pattern of entry.resources ?? []) {
      if (!files.some((file) => globToRegExp(pattern).test(file))) {
        throw new BuildError(`web_accessible_resources : aucun fichier construit pour ${pattern}`);
      }
    }
  }
  for (const file of files.filter((candidate) => candidate.endsWith(".js"))) {
    const code = fs.readFileSync(path.join(dir, file), "utf8");
    for (const [, , specifier] of code.matchAll(RELATIVE_SPECIFIER)) {
      if (specifier === undefined) continue;
      if (specifier.endsWith(".ts")) throw new BuildError(`${file} importe encore ${specifier}`);
      const target = path.posix.join(path.posix.dirname(file), specifier);
      if (!files.includes(target)) throw new BuildError(`${file} importe ${specifier}, absent de la sortie`);
    }
  }
}

/** Chrome n'accepte que 1 à 4 entiers d'au plus 65535, séparés par des points. */
const CHROME_VERSION = /^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/;

/**
 * Le manifeste construit : celui de omp-chrome/manifest.json, qui ne porte PAS de
 * version, plus la version de omp-chrome/package.json (le porteur que bumpe
 * scripts/release.ts). Deux sources divergeraient au premier bump.
 */
function builtManifest(): string {
  const source = JSON.parse(fs.readFileSync(path.join(EXTENSION, "manifest.json"), "utf8")) as Record<string, unknown>;
  if ("version" in source)
    throw new BuildError(
      "omp-chrome/manifest.json porte une version : elle vit dans omp-chrome/package.json, seule montée par la release",
    );
  const pkg = JSON.parse(fs.readFileSync(path.join(EXTENSION, "package.json"), "utf8")) as { version?: unknown };
  const version = pkg.version;
  if (typeof version !== "string" || !CHROME_VERSION.test(version) || version.split(".").some((n) => Number(n) > 65535))
    throw new BuildError(`omp-chrome/package.json : version « ${String(version)} » illisible par Chrome`);
  const { manifest_version, name, ...rest } = source;
  return `${JSON.stringify({ manifest_version, name, version, ...rest }, null, 2)}\n`;
}

/** Construit dans un dossier voisin, vérifie, puis remplace `out` d'un coup. */
function build(out: string): number {
  if (fs.existsSync(out) && fs.readdirSync(out).length > 0 && !fs.existsSync(path.join(out, "manifest.json"))) {
    throw new BuildError(`${out} n'est pas une construction de l'extension : il n'est pas écrasé`);
  }
  const staging = `${out}.construction-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  const files: string[] = [];
  const write = (relative: string, content: string | Buffer) => {
    const target = path.join(staging, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    files.push(relative.split(path.sep).join("/"));
  };
  try {
    for (const file of walk(SOURCES)) {
      const relative = path.relative(SOURCES, file);
      if (file.endsWith(".d.ts")) continue;
      if (file.endsWith(".ts")) {
        let code: string;
        try {
          code = stripTypeScriptTypes(fs.readFileSync(file, "utf8"), { mode: "strip", sourceUrl: relative });
        } catch (error) {
          throw new BuildError(
            `${path.relative(ROOT, file)} : ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        write(relative.replace(/\.ts$/, ".js"), code.replace(RELATIVE_TS, "$1$2$3.js$2"));
      } else if (COPIED[path.extname(file)] === true) {
        write(relative, fs.readFileSync(file));
      } else {
        throw new BuildError(`${path.relative(ROOT, file)} : type de fichier inattendu dans omp-chrome/src`);
      }
    }
    write("manifest.json", builtManifest());
    for (const size of [16, 32, 48, 128]) write(`icons/icon-${size}.png`, icon(size));
    verify(staging, files);
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.renameSync(staging, out);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return files.length;
}

const out = path.resolve(process.argv[2] ?? path.join(EXTENSION, "dist"));
try {
  const count = build(out);
  console.log(`  ✓ extension construite dans ${path.relative(process.cwd(), out) || "."} (${count} fichiers)`);
} catch (error) {
  if (!(error instanceof BuildError) && !(error instanceof SyntaxError)) throw error;
  console.error(`  ✗ construction de l'extension : ${error.message}`);
  process.exit(1);
}
