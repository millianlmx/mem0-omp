// Les GARDES de la feature `ios-identite-app` : c'est le SEUL fichier
// `test/*.test.ts` qui porte ce slug.
//
// Chaque garde lit des fichiers versionnés du dépôt (plist, catalogue d'actifs,
// projet Xcode, en-têtes binaires des PNG et de l'icns) et rend une liste de fautes, vide sur le
// dépôt ; une faute PLANTÉE en mémoire (rien n'est écrit dans le dépôt) doit la
// faire rougir. Ce que l'écran d'accueil d'iOS montre (icône sous « OMP Console »,
// en clair et en sombre) se prouve au simulateur par la recette de la feature.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT } from "../support/repo.ts";

const MAC_PLIST = path.join("omp-console", "Bundle", "Info.plist");
const MAC_ICNS = path.join("omp-console", "Bundle", "AppIcon.icns");
const CATALOG = path.join("omp-console", "ios", "OMPConsoleIOS", "Assets.xcassets");
const CATALOG_CONTENTS = path.join(CATALOG, "Contents.json");
const APPICON = path.join(CATALOG, "AppIcon.appiconset");
const APPICON_CONTENTS = path.join(APPICON, "Contents.json");
const ACCENT_CONTENTS = path.join(CATALOG, "AccentColor.colorset", "Contents.json");
const PBXPROJ = path.join("omp-console", "ios", "OMPConsoleIOS.xcodeproj", "project.pbxproj");
const IOS_PLIST = path.join("omp-console", "ios", "OMPConsoleIOS-Info.plist");

/** Les fichiers lus par les gardes, chemin relatif → octets. */
type Files = Map<string, Buffer>;

function read(files: Files, rel: string): Buffer | undefined {
  if (files.has(rel)) return files.get(rel);
  const abs = path.join(ROOT, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs) : undefined;
}

/** Une copie des fichiers du dépôt où `rel` est remplacé (faute plantée en mémoire). */
function planted(rel: string, content: Buffer | string): Files {
  return new Map([[rel, Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8")]]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** L'en-tête IHDR d'un PNG : largeur, hauteur, profondeur et type couleur ; null si ce n'est pas un PNG. */
function pngHeader(bytes: Buffer): { width: number; height: number; depth: number; colorType: number } | null {
  if (bytes.length < 26 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (bytes.toString("latin1", 12, 16) !== "IHDR") return null;
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    depth: bytes[24],
    colorType: bytes[25],
  };
}

/** Les entrées d'un `.icns` (type sur 4 octets, longueur big-endian sur 4, en-tête compris). */
function icnsEntries(bytes: Buffer): Map<string, Buffer> | null {
  if (bytes.length < 8 || bytes.toString("latin1", 0, 4) !== "icns") return null;
  const total = Math.min(bytes.readUInt32BE(4), bytes.length);
  const entries = new Map<string, Buffer>();
  let offset = 8;
  while (offset + 8 <= total) {
    const type = bytes.toString("latin1", offset, offset + 4);
    const length = bytes.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > total) return null;
    entries.set(type, bytes.subarray(offset + 8, offset + length));
    offset += length;
  }
  return entries;
}

/** AC-1, volet Mac : la plist nomme l'icône et l'icns versionné porte l'image 1024 px. */
function macIconFaults(files: Files = new Map()): string[] {
  const faults: string[] = [];
  const plist = read(files, MAC_PLIST)?.toString("utf8");
  if (plist === undefined) faults.push(`${MAC_PLIST} : absent`);
  else if (plist.match(/<key>CFBundleIconFile<\/key>\s*<string>([^<]*)<\/string>/)?.[1] !== "AppIcon") {
    faults.push(`${MAC_PLIST} : CFBundleIconFile ≠ AppIcon`);
  }
  const icns = read(files, MAC_ICNS);
  if (icns === undefined) {
    faults.push(`${MAC_ICNS} : absent (bash scripts/app-icon.sh)`);
    return faults;
  }
  const entries = icnsEntries(icns);
  if (entries === null) {
    faults.push(`${MAC_ICNS} : pas un icns (magic \`icns\` ou entrées illisibles)`);
    return faults;
  }
  const ic10 = entries.get("ic10");
  if (ic10 === undefined) {
    faults.push(`${MAC_ICNS} : entrée ic10 (1024 px) absente`);
    return faults;
  }
  const header = pngHeader(ic10);
  if (header === null || header.width !== 1024 || header.height !== 1024) {
    faults.push(`${MAC_ICNS} : l'entrée ic10 n'est pas un PNG 1024 × 1024`);
  }
  return faults;
}

/** Les variantes attendues : apparence de luminosité (null = claire), fichier, type couleur PNG. */
const VARIANTS = [
  { luminosity: null, filename: "AppIcon.png", colorType: 2 },
  { luminosity: "dark", filename: "AppIcon-dark.png", colorType: 2 },
  { luminosity: "tinted", filename: "AppIcon-tinted.png", colorType: 0 },
] as const;

type CatalogImage = {
  filename?: unknown;
  idiom?: unknown;
  platform?: unknown;
  size?: unknown;
  appearances?: unknown;
};

function parseJSON(files: Files, rel: string, faults: string[]): unknown {
  const bytes = read(files, rel);
  if (bytes === undefined) {
    faults.push(`${rel} : absent`);
    return undefined;
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    faults.push(`${rel} : JSON illisible`);
    return undefined;
  }
}

/** AC-3 : l'AppIcon déclare les trois variantes, chacune pourvue d'un PNG 1024² du type imposé. */
function appIconFaults(files: Files = new Map()): string[] {
  const faults: string[] = [];
  const root = parseJSON(files, CATALOG_CONTENTS, faults) as
    | { info?: { author?: unknown; version?: unknown } }
    | undefined;
  if (root !== undefined && (root.info?.author !== "xcode" || root.info?.version !== 1)) {
    faults.push(`${CATALOG_CONTENTS} : info ≠ {author: xcode, version: 1}`);
  }
  const contents = parseJSON(files, APPICON_CONTENTS, faults) as { images?: CatalogImage[] } | undefined;
  if (contents === undefined) return faults;
  const images = Array.isArray(contents.images) ? contents.images : [];
  if (images.length !== VARIANTS.length) {
    faults.push(`${APPICON_CONTENTS} : ${images.length} image(s) déclarée(s), 3 attendues`);
  }
  for (const variant of VARIANTS) {
    const label = variant.luminosity ?? "claire";
    const matching = images.filter((image) => {
      const appearances = Array.isArray(image.appearances) ? image.appearances : [];
      if (variant.luminosity === null) return appearances.length === 0;
      return (
        appearances.length === 1 &&
        appearances[0]?.appearance === "luminosity" &&
        appearances[0]?.value === variant.luminosity
      );
    });
    if (matching.length !== 1) {
      faults.push(`${APPICON_CONTENTS} : variante ${label} déclarée ${matching.length} fois, 1 attendue`);
      continue;
    }
    const image = matching[0];
    if (image.idiom !== "universal" || image.platform !== "ios" || image.size !== "1024x1024") {
      faults.push(`${APPICON_CONTENTS} : variante ${label} ≠ universal / ios / 1024x1024`);
    }
    if (image.filename !== variant.filename) {
      faults.push(
        `${APPICON_CONTENTS} : variante ${label} pointe ${String(image.filename)}, ${variant.filename} attendu`,
      );
      continue;
    }
    const rel = path.join(APPICON, variant.filename);
    const bytes = read(files, rel);
    if (bytes === undefined) {
      faults.push(`${rel} : absent (bash scripts/app-icon.sh)`);
      continue;
    }
    const header = pngHeader(bytes);
    if (header === null) {
      faults.push(`${rel} : pas un PNG`);
      continue;
    }
    if (header.width !== 1024 || header.height !== 1024) {
      faults.push(`${rel} : ${header.width} × ${header.height}, 1024 × 1024 attendu`);
    }
    if (header.depth !== 8 || header.colorType !== variant.colorType) {
      faults.push(
        `${rel} : PNG ${header.depth} bits type ${header.colorType}, 8 bits type ${variant.colorType} attendu`,
      );
    }
  }
  return faults;
}

/**
 * Les quatre valeurs de `UIColor.systemBlue` sur iOS 27 (D-3), clé = apparences
 * triées. Une référence `systemBlueColor` serait compilée en UNE couleur fixe.
 */
const ACCENT_VARIANTS = [
  { key: "", label: "défaut", rgb: [0.0, 0.533, 1.0] },
  { key: "luminosity=dark", label: "sombre", rgb: [0.0, 0.569, 1.0] },
  { key: "contrast=high", label: "contraste élevé", rgb: [0.118, 0.431, 0.957] },
  { key: "contrast=high+luminosity=dark", label: "sombre + contraste élevé", rgb: [0.361, 0.722, 1.0] },
] as const;

type CatalogColor = {
  idiom?: unknown;
  appearances?: unknown;
  color?: { "color-space"?: unknown; reference?: unknown; components?: Record<string, unknown> };
};

function appearanceKey(appearances: unknown): string {
  if (!Array.isArray(appearances)) return "";
  return appearances
    .map((entry: { appearance?: unknown; value?: unknown }) => `${String(entry?.appearance)}=${String(entry?.value)}`)
    .sort()
    .join("+");
}

/** Les blocs `buildSettings` des XCBuildConfiguration du projet, avec leur nom. */
function buildConfigurations(pbxproj: string): { name: string; settings: string }[] {
  const blocks: { name: string; settings: string }[] = [];
  const pattern = /\/\* (\w+) \*\/ = \{\s*isa = XCBuildConfiguration;\s*buildSettings = \{([\s\S]*?)\n\t\t\t\};/g;
  for (const match of pbxproj.matchAll(pattern)) blocks.push({ name: match[1], settings: match[2] });
  return blocks;
}

const APP_BUNDLE_LINE = "PRODUCT_BUNDLE_IDENTIFIER = com.omp.console.ios;";
const ASSETCATALOG_SETTINGS = [
  { key: "ASSETCATALOG_COMPILER_APPICON_NAME", value: "AppIcon" },
  { key: "ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME", value: "AccentColor" },
] as const;

/** AC-4, volet catalogue : l'AccentColor vaut le bleu système (4 valeurs), et seule la cible app la compile. */
function accentColorFaults(files: Files = new Map()): string[] {
  const faults: string[] = [];
  const contents = parseJSON(files, ACCENT_CONTENTS, faults) as { colors?: CatalogColor[] } | undefined;
  if (contents !== undefined) {
    const colors = Array.isArray(contents.colors) ? contents.colors : [];
    if (colors.length !== ACCENT_VARIANTS.length) {
      faults.push(`${ACCENT_CONTENTS} : ${colors.length} couleur(s) déclarée(s), 4 attendues`);
    }
    for (const variant of ACCENT_VARIANTS) {
      const matching = colors.filter((color) => appearanceKey(color.appearances) === variant.key);
      if (matching.length !== 1) {
        faults.push(`${ACCENT_CONTENTS} : variante ${variant.label} déclarée ${matching.length} fois, 1 attendue`);
        continue;
      }
      const { idiom, color } = matching[0];
      if (color?.reference !== undefined) {
        faults.push(
          `${ACCENT_CONTENTS} : variante ${variant.label} par référence ${String(color.reference)}, valeurs sRGB explicites attendues`,
        );
        continue;
      }
      const components = color?.components ?? {};
      const actual = ["red", "green", "blue", "alpha"].map((channel) => Number(components[channel]));
      const expected = [...variant.rgb, 1];
      const off = actual.some((value, index) => !(Math.abs(value - expected[index]) <= 0.001));
      if (idiom !== "universal" || color?.["color-space"] !== "srgb" || off) {
        faults.push(
          `${ACCENT_CONTENTS} : variante ${variant.label} ≠ universal / srgb (${expected.map((v) => v.toFixed(3)).join(", ")})`,
        );
      }
    }
  }

  const pbxproj = read(files, PBXPROJ)?.toString("utf8");
  if (pbxproj === undefined) {
    faults.push(`${PBXPROJ} : absent`);
    return faults;
  }
  const appConfigurations = buildConfigurations(pbxproj).filter((block) => block.settings.includes(APP_BUNDLE_LINE));
  for (const { key, value } of ASSETCATALOG_SETTINGS) {
    const total = pbxproj.match(new RegExp(`\\b${key}\\b`, "g"))?.length ?? 0;
    const line = `${key} = ${value};`;
    const inApp = appConfigurations.filter((block) => block.settings.split("\n").some((row) => row.trim() === line));
    const names = inApp
      .map((block) => block.name)
      .sort()
      .join(" + ");
    if (total !== 2 || names !== "Debug + Release") {
      faults.push(
        `${PBXPROJ} : ${key} présent ${total} fois (${names || "aucune configuration app"}), attendu = ${value} dans Debug et Release de com.omp.console.ios seulement`,
      );
    }
  }
  return faults;
}

const NETWORK_MESSAGE =
  "OMP Console se connecte à votre Mac sur le réseau local pour afficher et piloter vos pipelines.";
const NETWORK_PREFIX = "OMP Console se connecte à votre Mac";

/** AC-7 : le message de l'alerte « Réseau local » parle à l'utilisateur, au vouvoiement, sans vocabulaire interne. */
function networkMessageFaults(files: Files = new Map()): string[] {
  const faults: string[] = [];
  const plist = read(files, IOS_PLIST)?.toString("utf8");
  if (plist === undefined) return [`${IOS_PLIST} : absent`];
  const message = plist.match(/<key>NSLocalNetworkUsageDescription<\/key>\s*<string>([^<]*)<\/string>/)?.[1];
  if (message === undefined) return [`${IOS_PLIST} : NSLocalNetworkUsageDescription absent`];
  if (message !== NETWORK_MESSAGE) faults.push(`${IOS_PLIST} : message ≠ « ${NETWORK_MESSAGE} »`);
  if (!message.startsWith(NETWORK_PREFIX))
    faults.push(`${IOS_PLIST} : le message ne commence pas par « ${NETWORK_PREFIX} »`);
  for (const word of ["coque", "macos"]) {
    if (message.toLowerCase().includes(word)) faults.push(`${IOS_PLIST} : le message contient « ${word} »`);
  }
  if (!/\bvotre\b/.test(message) || !/\bvos\b/.test(message))
    faults.push(`${IOS_PLIST} : le message ne vouvoie pas (« votre », « vos »)`);
  if (message.includes("'")) faults.push(`${IOS_PLIST} : apostrophe droite dans le message`);
  const services = plist.match(/<key>NSBonjourServices<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1];
  const names = [...(services ?? "").matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1]);
  if (names.join(",") !== "_ompconsole._tcp") faults.push(`${IOS_PLIST} : NSBonjourServices ≠ [_ompconsole._tcp]`);
  if (!/<key>NSAllowsArbitraryLoads<\/key>\s*<true\/>/.test(plist))
    faults.push(`${IOS_PLIST} : NSAllowsArbitraryLoads ≠ true`);
  // Présent, il fait ignorer NSAllowsArbitraryLoads : l'adresse Tailscale (100.64/10) échouerait en -1022.
  if (plist.includes("<key>NSAllowsLocalNetworking</key>"))
    faults.push(`${IOS_PLIST} : NSAllowsLocalNetworking présent`);
  return faults;
}

const IOS_DIR = path.join("omp-console", "ios");
const LAUNCH_GENERATION_LINE = "INFOPLIST_KEY_UILaunchScreen_Generation = YES;";

/** Les chemins relatifs de tous les fichiers sous `omp-console/ios` (les paquets `.xcassets`, `.xcodeproj` compris). */
function iosTree(): string[] {
  return fs
    .readdirSync(path.join(ROOT, IOS_DIR), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(ROOT, path.join(entry.parentPath, entry.name)))
    .sort();
}

/**
 * AC-8 : l'écran de lancement reste celui que génère Xcode — `UILaunchScreen` vide,
 * donc le fond système, égal au fond du premier écran. Toute couleur, image ou
 * storyboard de lancement est une faute.
 */
function launchScreenFaults(files: Files = new Map(), tree: string[] = iosTree()): string[] {
  const faults: string[] = [];
  const pbxproj = read(files, PBXPROJ)?.toString("utf8");
  if (pbxproj === undefined) {
    faults.push(`${PBXPROJ} : absent`);
  } else {
    const extra = [...new Set([...pbxproj.matchAll(/\bINFOPLIST_KEY_UILaunch\w*/g)].map((match) => match[0]))]
      .filter((key) => key !== "INFOPLIST_KEY_UILaunchScreen_Generation")
      .sort();
    for (const key of extra)
      faults.push(`${PBXPROJ} : ${key} interdit (seul INFOPLIST_KEY_UILaunchScreen_Generation est admis)`);
    const generating = buildConfigurations(pbxproj)
      .filter((block) => block.settings.includes(APP_BUNDLE_LINE))
      .filter((block) => block.settings.split("\n").some((row) => row.trim() === LAUNCH_GENERATION_LINE))
      .map((block) => block.name)
      .sort()
      .join(" + ");
    if (generating !== "Debug + Release") {
      faults.push(
        `${PBXPROJ} : ${LAUNCH_GENERATION_LINE} dans ${generating || "aucune configuration app"}, attendu dans Debug et Release de com.omp.console.ios`,
      );
    }
  }

  const plist = read(files, IOS_PLIST)?.toString("utf8");
  if (plist === undefined) {
    faults.push(`${IOS_PLIST} : absent`);
  } else {
    for (const key of ["UILaunchScreen", "UILaunchStoryboardName"]) {
      if (plist.includes(`<key>${key}</key>`)) faults.push(`${IOS_PLIST} : clé ${key} interdite`);
    }
  }

  for (const rel of tree) {
    if (rel.endsWith(".storyboard")) faults.push(`${rel} : storyboard interdit sous ${IOS_DIR}`);
  }
  return faults;
}

const DESIGN = path.join("omp-console", "ios", "DESIGN.md");
const IDENTITY_HEADING = "## Identité de l'app (feature ios-identite-app)";
const PREVIOUS_HEADING = "## Accessibilité et langue (feature `accessibilite-et-localisation-ios-residu`)";
const IDENTITY_TESTS = path.join("omp-console", "ios", "OMPConsoleIOSTests", "IOSIdentiteTests.swift");
/** Les marqueurs des quatre puces, dans l'ordre : icône, accent, message réseau, écran de lancement. */
const IDENTITY_MARKERS = [
  "appIconIsDeclared",
  "accentColorIsSystemBlue",
  "localNetworkMessageSpeaksToTheUser",
  "launchScreenUsesSystemBackground",
] as const;
/** Les puces du nom et de la région, dans la section précédente, qui restent telles quelles. */
const KEPT_MARKERS = ["homeScreenNameIsOMPConsole", "appIsFrenchOnly"] as const;

/** Les puces d'un texte Markdown : une ligne « - » puis ses suites indentées de 2 espaces (règle de `design-ios`). */
function bullets(lines: string[]): string[][] {
  const blocks: string[][] = [];
  for (const line of lines) {
    if (line.startsWith("- ")) blocks.push([line]);
    else if (line.startsWith("  ") && blocks.length > 0) blocks[blocks.length - 1].push(line);
  }
  return blocks;
}

/**
 * AC-10 : DESIGN.md décrit l'identité de l'app dans sa section, juste après
 * « Accessibilité et langue », en quatre puces dont la dernière ligne finit par
 * le marqueur `[test: …]` d'une fonction de `IOSIdentiteTests.swift` ; aucun
 * marqueur `[capture:]` ni `[garde:]` neuf, et les puces du nom et de la région
 * restent en place.
 */
function designIdentityFaults(files: Files = new Map()): string[] {
  const design = read(files, DESIGN)?.toString("utf8");
  if (design === undefined) return [`${DESIGN} : absent`];
  const lines = design.split("\n");
  const start = lines.indexOf(IDENTITY_HEADING);
  if (start === -1) return [`${DESIGN} : section « ${IDENTITY_HEADING} » absente`];
  const faults: string[] = [];
  const previous = lines.slice(0, start).findLast((line) => line.startsWith("## "));
  if (previous !== PREVIOUS_HEADING)
    faults.push(`${DESIGN} : la section suit « ${previous ?? "rien"} », attendu « ${PREVIOUS_HEADING} »`);

  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  const section = lines.slice(start + 1, end === -1 ? lines.length : end);
  const blocks = bullets(section);
  if (blocks.length !== IDENTITY_MARKERS.length) {
    faults.push(`${DESIGN} : ${blocks.length} puce(s) dans la section, ${IDENTITY_MARKERS.length} attendues`);
  }
  const swift = read(files, IDENTITY_TESTS)?.toString("utf8") ?? "";
  IDENTITY_MARKERS.forEach((name, index) => {
    const marker = `\`[test: ${name}]\``;
    const last = blocks[index]?.at(-1)?.trimEnd();
    if (last === undefined || !last.endsWith(marker))
      faults.push(`${DESIGN} : la puce ${index + 1} ne finit pas par ${marker}`);
    if (!new RegExp(`func ${name}\\s*\\(`).test(swift)) faults.push(`${IDENTITY_TESTS} : aucune fonction ${name}`);
  });
  for (const [, kind, value] of section.join("\n").matchAll(/\[(capture|garde): ([^\]]+)\]/g)) {
    faults.push(`${DESIGN} : marqueur [${kind}: ${value}] interdit dans la section (aucune capture ni garde neuve)`);
  }

  const before = lines.slice(0, start).join("\n");
  for (const name of KEPT_MARKERS) {
    if (!before.includes(`[test: ${name}]`))
      faults.push(`${DESIGN} : la puce [test: ${name}] a quitté la section précédente`);
  }
  return faults;
}

test("ios-identite-app/AC-1 : l'app Mac porte l'icône d'OMP Console (CFBundleIconFile, icns avec son image 1024 px)", () => {
  assert.deepEqual(macIconFaults(), []);

  const plist = fs.readFileSync(path.join(ROOT, MAC_PLIST), "utf8");
  const withoutKey = plist.replace(/\s*<key>CFBundleIconFile<\/key>\s*<string>AppIcon<\/string>/, "");
  assert.notEqual(withoutKey, plist, "la faute plantée doit retirer CFBundleIconFile");
  assert.deepEqual(macIconFaults(planted(MAC_PLIST, withoutKey)), [`${MAC_PLIST} : CFBundleIconFile ≠ AppIcon`]);

  const icns = fs.readFileSync(path.join(ROOT, MAC_ICNS));
  // L'en-tête de l'entrée ic10 est rebaptisé : l'offset vient du parcours des
  // entrées, jamais d'une recherche d'octets qui pourrait tomber dans une image.
  const ic10 = icnsEntries(icns)?.get("ic10");
  assert.ok(ic10 !== undefined, "l'icns du dépôt doit porter une entrée ic10");
  const renamed = Buffer.from(icns);
  renamed.write("ic09", ic10.byteOffset - icns.byteOffset - 8, "latin1");
  assert.deepEqual(macIconFaults(planted(MAC_ICNS, renamed)), [`${MAC_ICNS} : entrée ic10 (1024 px) absente`]);
});

test("ios-identite-app/AC-3 : l'AppIcon déclare les variantes claire, sombre et teintée, chacune pourvue d'un PNG 1024² du type imposé", () => {
  assert.deepEqual(appIconFaults(), []);

  const contents = JSON.parse(fs.readFileSync(path.join(ROOT, APPICON_CONTENTS), "utf8")) as { images: CatalogImage[] };
  const withoutTinted = {
    ...contents,
    images: contents.images.filter((image) => image.filename !== "AppIcon-tinted.png"),
  };
  assert.deepEqual(appIconFaults(planted(APPICON_CONTENTS, JSON.stringify(withoutTinted))), [
    `${APPICON_CONTENTS} : 2 image(s) déclarée(s), 3 attendues`,
    `${APPICON_CONTENTS} : variante tinted déclarée 0 fois, 1 attendue`,
  ]);

  // Une teintée en RGB (type 2) au lieu de niveaux de gris (type 0).
  const tinted = path.join(APPICON, "AppIcon-tinted.png");
  const rgbTinted = Buffer.from(fs.readFileSync(path.join(ROOT, tinted)));
  rgbTinted[25] = 2;
  assert.deepEqual(appIconFaults(planted(tinted, rgbTinted)), [`${tinted} : PNG 8 bits type 2, 8 bits type 0 attendu`]);
});

test("ios-identite-app/AC-4 : l'AccentColor du catalogue vaut le bleu système (quatre valeurs sRGB, aucune référence), compilée par la seule cible app", () => {
  assert.deepEqual(accentColorFaults(), []);

  // La forme mesurée fausse en /specs (D-3) : une référence, compilée en une couleur fixe sans sombre.
  const reference = {
    colors: [{ color: { platform: "ios", reference: "systemBlueColor" }, idiom: "universal" }],
    info: { author: "xcode", version: 1 },
  };
  assert.deepEqual(accentColorFaults(planted(ACCENT_CONTENTS, JSON.stringify(reference))), [
    `${ACCENT_CONTENTS} : 1 couleur(s) déclarée(s), 4 attendues`,
    `${ACCENT_CONTENTS} : variante défaut par référence systemBlueColor, valeurs sRGB explicites attendues`,
    `${ACCENT_CONTENTS} : variante sombre déclarée 0 fois, 1 attendue`,
    `${ACCENT_CONTENTS} : variante contraste élevé déclarée 0 fois, 1 attendue`,
    `${ACCENT_CONTENTS} : variante sombre + contraste élevé déclarée 0 fois, 1 attendue`,
  ]);

  // La clé d'accent posée aussi dans la cible de tests.
  const pbxproj = fs.readFileSync(path.join(ROOT, PBXPROJ), "utf8");
  const leaked = pbxproj.replace(
    'BUNDLE_LOADER = "$(TEST_HOST)";',
    'ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME = AccentColor;\n\t\t\t\tBUNDLE_LOADER = "$(TEST_HOST)";',
  );
  assert.notEqual(leaked, pbxproj, "la faute plantée doit toucher la cible de tests");
  assert.deepEqual(accentColorFaults(planted(PBXPROJ, leaked)), [
    `${PBXPROJ} : ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME présent 3 fois (Debug + Release), attendu = AccentColor dans Debug et Release de com.omp.console.ios seulement`,
  ]);
});

test("ios-identite-app/AC-7 : le message « Réseau local » commence par « OMP Console se connecte à votre Mac », vouvoie et ne dit ni « coque » ni « macOS »", () => {
  assert.deepEqual(networkMessageFaults(), []);

  const plist = fs.readFileSync(path.join(ROOT, IOS_PLIST), "utf8");
  const old = plist.replace(
    NETWORK_MESSAGE,
    "OMP Console se connecte à la coque macOS sur votre réseau local pour piloter vos pipelines.",
  );
  assert.notEqual(old, plist, "la faute plantée doit remettre l'ancien texte");
  assert.deepEqual(networkMessageFaults(planted(IOS_PLIST, old)), [
    `${IOS_PLIST} : message ≠ « ${NETWORK_MESSAGE} »`,
    `${IOS_PLIST} : le message ne commence pas par « ${NETWORK_PREFIX} »`,
    `${IOS_PLIST} : le message contient « coque »`,
    `${IOS_PLIST} : le message contient « macos »`,
  ]);
});

test("ios-identite-app/AC-8 : l'écran de lancement reste celui que génère Xcode (UILaunchScreen vide, fond système), sans couleur, image ni storyboard", () => {
  assert.deepEqual(launchScreenFaults(), []);

  // Une couleur de fond posée sur l'écran de lancement de la cible app.
  const pbxproj = fs.readFileSync(path.join(ROOT, PBXPROJ), "utf8");
  const colored = pbxproj.replace(
    LAUNCH_GENERATION_LINE,
    `INFOPLIST_KEY_UILaunchScreen_BackgroundColor = AccentColor;\n\t\t\t\t${LAUNCH_GENERATION_LINE}`,
  );
  assert.notEqual(colored, pbxproj, "la faute plantée doit toucher une configuration de la cible app");
  assert.deepEqual(launchScreenFaults(planted(PBXPROJ, colored)), [
    `${PBXPROJ} : INFOPLIST_KEY_UILaunchScreen_BackgroundColor interdit (seul INFOPLIST_KEY_UILaunchScreen_Generation est admis)`,
  ]);

  // Un storyboard de lancement déclaré dans le plist source et posé dans l'arbre.
  const plist = fs.readFileSync(path.join(ROOT, IOS_PLIST), "utf8");
  const storyboard = plist.replace(
    "<dict>",
    "<dict>\n\t<key>UILaunchStoryboardName</key>\n\t<string>LaunchScreen</string>",
  );
  assert.notEqual(storyboard, plist, "la faute plantée doit toucher le plist source");
  const launchFile = path.join(IOS_DIR, "OMPConsoleIOS", "LaunchScreen.storyboard");
  assert.deepEqual(launchScreenFaults(planted(IOS_PLIST, storyboard), [...iosTree(), launchFile]), [
    `${IOS_PLIST} : clé UILaunchStoryboardName interdite`,
    `${launchFile} : storyboard interdit sous ${IOS_DIR}`,
  ]);
});

test("ios-identite-app/AC-10 : DESIGN.md décrit l'icône, l'accent, le message réseau et l'écran de lancement, une puce et son marqueur [test:] chacun, après « Accessibilité et langue »", () => {
  assert.deepEqual(designIdentityFaults(), []);

  // Un marqueur retiré : la puce de l'accent finit sans son test.
  const design = fs.readFileSync(path.join(ROOT, DESIGN), "utf8");
  const unmarked = design.replace(" `[test: accentColorIsSystemBlue]`", "");
  assert.notEqual(unmarked, design, "la faute plantée doit retirer le marqueur de l'accent");
  assert.deepEqual(designIdentityFaults(planted(DESIGN, unmarked)), [
    `${DESIGN} : la puce 2 ne finit pas par \`[test: accentColorIsSystemBlue]\``,
  ]);

  // La section déplacée ailleurs, avec une capture neuve.
  const block = design.slice(design.indexOf(IDENTITY_HEADING), design.indexOf("## Les six tons"));
  const moved = design
    .replace(block, "")
    .replace(
      "## États vide et erreur",
      `${block.replace("(TN3179)", "(TN3179) `[capture: iphone-home-light]`")}## États vide et erreur`,
    );
  assert.deepEqual(designIdentityFaults(planted(DESIGN, moved)), [
    `${DESIGN} : la section suit « ## Les six tons », attendu « ${PREVIOUS_HEADING} »`,
    `${DESIGN} : marqueur [capture: iphone-home-light] interdit dans la section (aucune capture ni garde neuve)`,
  ]);
});
