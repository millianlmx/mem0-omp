// omp-console sans podman (feature omp-console-sans-podman).
//
// AC-1 exécute le vrai scripts/swift-app.sh dans une copie jetable réduite à ce
// qu'il lit (le script, omp-console/Bundle, omp-console/Sources/OMPConsole,
// l'ancienne pile omp-console/stack), avec des doublures sur le PATH pour chaque
// outil externe (uname, swift, codesign, otool, cargo, lipo, et l'outillage Xcode
// de test/support/swift-app-doubles.ts : xcrun, appintentsmetadataprocessor) :
// aucune compilation réelle, le test est
// portable. Le PATH ne garde que les dossiers système, pour qu'un cargo installé
// (Homebrew, rustup) ne masque jamais l'absence voulue de la doublure.
//
// AC-6, AC-7 et AC-12 sont prouvés en conditions réelles par
// scripts/recette/sans-podman-bascule-recette.sh, joué par l'orchestrateur sur le poste
// (jamais ici). Ces tests verrouillent le VERDICT de cette recette, pour qu'une
// bascule ratée ne puisse pas y paraître verte : racine jetable
// (`OMP_CONSOLE_SUPPORT_ROOT`), relevé `recette-avant.json` écrit à la main,
// faux service mémoire HTTP sur un port éphémère (`OMP_CONSOLE_MEM0_PORT`),
// doublures `uname` (Darwin) et `launchctl` sur le PATH. Aucun ne touche
// launchd, podman ni les ports 8321/6333 du poste — seul le mode `relance`
// interroge 127.0.0.1:6333 en lecture, avec une clé jetable, et n'en attend
// qu'un échec.
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, tmpdir } from "../support/repo.ts";
import { SWIFT_CONST_VALUES_SNIPPET, writeXcodeDoubles } from "../support/swift-app-doubles.ts";

function doublure(bin: string, nom: string, corps: string): void {
  const fichier = path.join(bin, nom);
  fs.writeFileSync(fichier, `#!/usr/bin/env bash\n${corps}\n`);
  fs.chmodSync(fichier, 0o755);
}

/** Tous les fichiers et dossiers sous `racine`, en chemins relatifs. */
function arborescence(racine: string): string[] {
  return (fs.readdirSync(racine, { recursive: true }) as string[]).map((entree) => entree.toString());
}

test("omp-console-sans-podman/AC-1 : swift-app.sh compile mem0-rs, l'embarque signé en Contents/Resources/mem0-rs (arm64) et n'embarque plus rien de l'ancienne pile", () => {
  // Copie jetable : ce que swift-app.sh lit (le script, le Bundle, les sources de
  // la coque, listées pour l'extraction App Intents), plus l'ancienne pile tant
  // qu'elle existe — sa présence dans le dépôt ne doit plus rien faire entrer au bundle.
  const copie = tmpdir("sans-podman-copie-");
  fs.mkdirSync(path.join(copie, "scripts"));
  fs.copyFileSync(path.join(ROOT, "scripts", "swift-app.sh"), path.join(copie, "scripts", "swift-app.sh"));
  fs.cpSync(path.join(ROOT, "omp-console", "Bundle"), path.join(copie, "omp-console", "Bundle"), { recursive: true });
  fs.cpSync(path.join(ROOT, "omp-console", "Sources", "OMPConsole"), path.join(copie, "omp-console", "Sources", "OMPConsole"), { recursive: true });
  const anciennePile = path.join(ROOT, "omp-console", "stack");
  if (fs.existsSync(anciennePile)) {
    fs.cpSync(anciennePile, path.join(copie, "omp-console", "stack"), {
      recursive: true,
      filter: (source) => !source.split(path.sep).includes("qdrant_storage"),
    });
  }

  const outils = tmpdir("sans-podman-outils-");
  const bin = path.join(outils, "bin");
  fs.mkdirSync(bin);
  const journal = path.join(outils, "journal.txt");

  doublure(bin, "uname", "printf 'Darwin\\n'");
  // swift : même doublure que socle-app-swift/AC-5 (test/outillage/check.test.ts),
  // valeurs constantes comprises quand l'argv porte `-emit-const-values`.
  doublure(
    bin,
    "swift",
    `scratch=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--scratch-path" ]; then scratch="$a"; fi
  prev="$a"
done
${SWIFT_CONST_VALUES_SNIPPET}
case "$*" in
  *--show-bin-path*)
    printf '%s\\n' "$scratch/out/Products/Release"
    ;;
  test*|build*)
    mkdir -p "$scratch/out/Products/Release"
    printf '#!/usr/bin/env bash\\nexit 0\\n' > "$scratch/out/Products/Release/OMPConsole"
    chmod +x "$scratch/out/Products/Release/OMPConsole"
    ;;
esac`,
  );
  doublure(bin, "otool", "printf '      cmd LC_BUILD_VERSION\\n  cmdsize 32\\n platform 1\\n    minos 26.0\\n      sdk 26.5\\n'");
  doublure(bin, "codesign", `printf 'codesign %s\\n' "$*" >> '${journal}'`);
  // cargo : journalise argv et cwd, pose le binaire là où le vrai l'écrit et y
  // inscrit le dossier cible, pour prouver d'où swift-app.sh l'a recopié.
  doublure(
    bin,
    "cargo",
    `printf 'cargo %s @ %s\\n' "$*" "$PWD" >> '${journal}'
target="\${CARGO_TARGET_DIR:-mem0-stack/mem0-rs/target}"
mkdir -p "$target/release"
printf '#!/usr/bin/env bash\\n# cible=%s\\nexit 0\\n' "$target" > "$target/release/mem0-rs"
chmod +x "$target/release/mem0-rs"`,
  );
  doublure(bin, "lipo", `printf 'lipo %s\\n' "$*" >> '${journal}'\nprintf '%s\\n' "\${FAUSSE_ARCH:-arm64}"`);
  // Outillage Xcode doublé : processeur App Intents, version d'Xcode, SDK macOS.
  writeXcodeDoubles(bin);

  const environnementDeBase = { ...process.env };
  delete environnementDeBase.CARGO_TARGET_DIR;
  const lancer = (args: string[], env: Record<string, string> = {}, chemin = `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`) => {
    fs.rmSync(journal, { force: true });
    const r = spawnSync("bash", ["scripts/swift-app.sh", ...args], {
      cwd: copie,
      encoding: "utf8",
      env: { ...environnementDeBase, PATH: chemin, ...env },
      timeout: 120_000,
    });
    const lignes = fs.existsSync(journal) ? fs.readFileSync(journal, "utf8").trim().split("\n") : [];
    return { ...r, sortie: `${r.stdout}${r.stderr}`, lignes };
  };

  const bundle = path.join(copie, "omp-console", "build", "OMP Console.app");
  const embarque = path.join(bundle, "Contents", "Resources", "mem0-rs");
  const argvCargo = `cargo build --release --locked --manifest-path mem0-stack/mem0-rs/Cargo.toml @ ${copie}`;

  // (1) Assemblage complet (suite comprise), cible cargo par défaut.
  const complet = lancer([]);
  assert.equal(complet.status, 0, complet.sortie);
  assert.ok(complet.lignes.includes(argvCargo), `argv/cwd de cargo : ${complet.lignes.join(" | ")}`);
  assert.ok(complet.lignes.includes(`lipo -archs ${path.join(copie, "mem0-stack/mem0-rs/target/release/mem0-rs")}`), complet.lignes.join(" | "));
  assert.ok(complet.sortie.includes("  ✓ mem0-rs embarqué (Contents/Resources/mem0-rs, arm64)"), complet.sortie);
  assert.ok(fs.existsSync(embarque), `${embarque} absent :\n${complet.sortie}`);
  assert.equal(fs.statSync(embarque).mode & 0o777, 0o755, "mem0-rs doit être en 0755");
  assert.ok(fs.readFileSync(embarque, "utf8").includes("# cible=mem0-stack/mem0-rs/target"), "mem0-rs doit venir de la cible par défaut");

  // Le binaire est signé ad hoc LUI-MÊME, avant la signature du bundle.
  const signatureBinaire = complet.lignes.indexOf(`codesign --force --sign - ${embarque}`);
  const signatureBundle = complet.lignes.indexOf(`codesign --force --sign - ${bundle}`);
  assert.notEqual(signatureBinaire, -1, `mem0-rs jamais signé : ${complet.lignes.join(" | ")}`);
  assert.notEqual(signatureBundle, -1, `bundle jamais signé : ${complet.lignes.join(" | ")}`);
  assert.ok(signatureBinaire < signatureBundle, `mem0-rs doit être signé avant le bundle : ${complet.lignes.join(" | ")}`);

  // Plus rien de l'ancienne pile : ni dossier Stack, ni Dockerfile, ni empreinte, ni source Python.
  assert.ok(!fs.existsSync(path.join(bundle, "Contents", "Resources", "Stack")), "Contents/Resources/Stack existe encore");
  const residus = arborescence(bundle).filter((entree) => {
    const nom = path.basename(entree);
    return nom === "Dockerfile" || nom === "STACK_FINGERPRINT" || nom.endsWith(".py");
  });
  assert.deepEqual(residus, [], `fichiers de l'ancienne pile dans le bundle : ${residus.join(", ")}`);

  // (2) Tour rapide `--no-tests` : cargo est appelé de même ; un CARGO_TARGET_DIR
  // relatif part de la racine du dépôt.
  const rapide = lancer(["--no-tests"], { CARGO_TARGET_DIR: "cible-rs" });
  assert.equal(rapide.status, 0, rapide.sortie);
  assert.ok(rapide.lignes.includes(argvCargo), `argv/cwd de cargo : ${rapide.lignes.join(" | ")}`);
  assert.ok(fs.existsSync(path.join(copie, "cible-rs", "release", "mem0-rs")), "cargo doit écrire sous <racine>/cible-rs");
  assert.ok(fs.readFileSync(embarque, "utf8").includes("# cible=cible-rs"), "mem0-rs doit venir de CARGO_TARGET_DIR");

  // (3) Un binaire qui n'est pas arm64 est refusé.
  const intel = lancer(["--no-tests"], { FAUSSE_ARCH: "x86_64" });
  assert.equal(intel.status, 1, intel.sortie);
  assert.ok(intel.stderr.includes("✗ mem0-rs n'est pas arm64 (lipo : x86_64)"), intel.sortie);

  // (4) Sans cargo : échec franc, aucun bundle produit.
  fs.rmSync(bundle, { recursive: true, force: true });
  fs.rmSync(path.join(bin, "cargo"));
  const sansCargo = lancer(["--no-tests"]);
  assert.equal(sansCargo.status, 1, sansCargo.sortie);
  assert.ok(sansCargo.stderr.includes("✗ cargo introuvable — installe Rust (https://rustup.rs)"), sansCargo.sortie);
  assert.ok(!fs.existsSync(bundle), "aucun bundle ne doit être produit sans cargo");
});

// ── Recette de la bascule réelle (S-9) ─────────────────────────────────────

const RECETTE = path.join(ROOT, "scripts", "recette", "sans-podman-bascule-recette.sh");
const JETON = "jeton-recette";
type Souvenir = { id: string; memory: string; agent_id?: string };
const SOUVENIRS: Souvenir[] = [
  { id: "11111111-1111-4111-8111-111111111111", memory: "le dépôt utilise bun", agent_id: "a1" },
  { id: "22222222-2222-4222-8222-222222222222", memory: "les tests portent l'id du critère", agent_id: "a1" },
  { id: "33333333-3333-4333-8333-333333333333", memory: "souvenir sans agent" },
];

/** Racine support jetable, bascule faite, relevé `avant` cohérent avec SOUVENIRS. */
function racineBasculee(): { racine: string; bin: string; journal: string } {
  const racine = tmpdir("sans-podman-recette-");
  const etat = path.join(racine, "stack", "podman-migration");
  fs.mkdirSync(etat, { recursive: true });
  fs.writeFileSync(path.join(racine, "stack", "env"), `QDRANT_API_KEY=cle-jetable\nMEM0_HTTP_TOKEN="${JETON}"\n`);
  const groupes = new Map<string | null, [string, string][]>();
  for (const s of SOUVENIRS) {
    const cle = s.agent_id ?? null;
    groupes.set(cle, [...(groupes.get(cle) ?? []), [s.id, s.memory]]);
  }
  const agents = [...groupes].map(([agent_id, souvenirs]) => ({ agent_id, souvenirs: souvenirs.sort() }));
  fs.writeFileSync(path.join(etat, "recette-avant.json"), JSON.stringify({ agents }));
  fs.writeFileSync(
    path.join(etat, "bascule.json"),
    JSON.stringify({ version: 1, switchedAt: "2026-10-12T00:00:00Z", source: "podman", rejected: 0, forced: false }),
  );
  fs.writeFileSync(path.join(etat, "import-report.json"), '{"agents":[],"totaux":{}}\n');
  const bin = tmpdir("sans-podman-bin-");
  const journal = path.join(bin, "launchctl.log");
  doublure(bin, "uname", 'echo Darwin');
  doublure(bin, "launchctl", `printf '%s\\n' "$*" >> '${journal}'\nexit 0`);
  return { racine, bin, journal };
}

/** Faux service mémoire : `/memory/all` et `/memory/search`, jeton exigé. */
async function fauxService(servis: () => Souvenir[], jetonAttendu = JETON): Promise<{ port: number; fermer: () => Promise<void> }> {
  const serveur = http.createServer((req, res) => {
    const repondre = (statut: number, corps: unknown) => {
      res.writeHead(statut, { "Content-Type": "application/json" });
      res.end(JSON.stringify(corps));
    };
    if (req.headers["x-mem0-token"] !== jetonAttendu) return repondre(401, { detail: "bad or missing X-Mem0-Token" });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/memory/all") {
      const agent = url.searchParams.get("agent_id");
      return repondre(200, { results: servis().filter((s) => agent === null || s.agent_id === agent) });
    }
    if (req.method === "POST" && url.pathname === "/memory/search") {
      let brut = "";
      req.on("data", (c) => (brut += c));
      req.on("end", () => {
        const corps = JSON.parse(brut) as { query: string; agent_id?: string };
        repondre(200, { results: servis().filter((s) => s.agent_id === corps.agent_id && s.memory === corps.query) });
      });
      return;
    }
    repondre(404, { detail: "Not Found" });
  });
  const ecoute = Promise.withResolvers<void>();
  serveur.listen(0, "127.0.0.1", () => ecoute.resolve());
  await ecoute.promise;
  return {
    port: (serveur.address() as AddressInfo).port,
    fermer: () => {
      const ferme = Promise.withResolvers<void>();
      serveur.close(() => ferme.resolve());
      return ferme.promise;
    },
  };
}

/** Lance la recette SANS bloquer la boucle d'événements (le faux service y répond). */
function recette(
  mode: string,
  ctx: { racine: string; bin: string },
  port: number,
  garde = true,
): Promise<{ status: number; sortie: string }> {
  const env: NodeJS.ProcessEnv = {
    HOME: ctx.racine,
    PATH: `${ctx.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    OMP_CONSOLE_SUPPORT_ROOT: ctx.racine,
    OMP_CONSOLE_MEM0_PORT: String(port),
  };
  if (garde) env.MEM0_SANS_PODMAN_REEL = "1";
  const fin = Promise.withResolvers<{ status: number; sortie: string }>();
  execFile("bash", [RECETTE, mode], { env, timeout: 60_000 }, (erreur, stdout, stderr) => {
    const code = erreur ? (typeof erreur.code === "number" ? erreur.code : -1) : 0;
    fin.resolve({ status: code, sortie: `${stdout}${stderr}` });
  });
  return fin.promise;
}

test("omp-console-sans-podman/AC-6 : la recette apres n'est verte que si chaque agent_id sert exactement les souvenirs d'avant et que la recherche répond, et rougit au premier écart", async () => {
  const ctx = racineBasculee();
  let servis = SOUVENIRS;
  const service = await fauxService(() => servis);
  try {
    const sansGarde = await recette("apres", ctx, service.port, false);
    assert.equal(sansGarde.status, 2, sansGarde.sortie);
    assert.ok(sansGarde.sortie.includes("non exécuté : MEM0_SANS_PODMAN_REEL=1 requis (bascule réelle du poste)"), sansGarde.sortie);

    const vert = await recette("apres", ctx, service.port);
    assert.equal(vert.status, 0, vert.sortie);
    for (const attendu of [
      "✓ bascule.json de source podman",
      "✓ agent a1 : 2 souvenirs identiques",
      "✓ agent (sans agent_id) : 1 souvenirs identiques",
      "✓ GET /memory/all sans paramètre rend exactement l'union d'avant (3 souvenirs)",
      "✓ POST /memory/search rend 1 résultat(s)",
      "✓ podman de l'app absent",
    ]) {
      assert.ok(vert.sortie.includes(attendu), `${attendu}\n${vert.sortie}`);
    }
    // Le label vérifié est celui de MemoryAgent.label(paths:) pour une racine surchargée.
    const label = `com.omp.console.mem0-rs.${createHash("sha256").update(ctx.racine).digest("hex").slice(0, 12)}`;
    assert.match(fs.readFileSync(ctx.journal, "utf8"), new RegExp(`^print gui/\\d+/${label.replaceAll(".", "\\.")}$`, "m"));
    assert.ok(fs.existsSync(path.join(ctx.racine, "stack", "podman-migration", "recette-apres.json")));

    // Un souvenir perdu, puis un texte altéré : rouge, sans aller plus loin.
    for (const altere of [SOUVENIRS.slice(1), [{ ...SOUVENIRS[0], memory: "texte altéré" }, ...SOUVENIRS.slice(1)]]) {
      servis = altere;
      const rouge = await recette("apres", ctx, service.port);
      assert.equal(rouge.status, 1, rouge.sortie);
      assert.match(rouge.sortie, /✗ agent a1 : 2 souvenirs identiques à la pile podman \/ \d servis/);
      assert.ok(!rouge.sortie.includes("POST /memory/search"), rouge.sortie);
    }

    // Une bascule sans source podman (racine vierge) n'est pas une migration.
    servis = SOUVENIRS;
    fs.writeFileSync(
      path.join(ctx.racine, "stack", "podman-migration", "bascule.json"),
      JSON.stringify({ version: 1, switchedAt: "2026-10-12T00:00:00Z", source: "none", rejected: 0, forced: false }),
    );
    const vierge = await recette("apres", ctx, service.port);
    assert.equal(vierge.status, 1, vierge.sortie);
    assert.ok(vierge.sortie.includes("✗ bascule.json de source podman / source « none »"), vierge.sortie);
  } finally {
    await service.fermer();
  }
});

test("omp-console-sans-podman/AC-7 : la recette relance rougit si bascule.json ou import-report.json a changé depuis apres, et avant refuse une bascule déjà faite", async () => {
  const ctx = racineBasculee();
  const service = await fauxService(() => SOUVENIRS);
  try {
    const avant = await recette("avant", ctx, service.port);
    assert.equal(avant.status, 1, avant.sortie);
    assert.ok(avant.sortie.includes("✗ aucune bascule avant le relevé"), avant.sortie);

    const apres = await recette("apres", ctx, service.port);
    assert.equal(apres.status, 0, apres.sortie);

    // Inchangés : les deux empreintes passent ; la suite exige un Qdrant joignable
    // avec la vraie clé, absent ici (ou refusé avec la clé jetable) ⇒ rouge nommé.
    const intacte = await recette("relance", ctx, service.port);
    assert.ok(intacte.sortie.includes("✓ bascule.json inchangé depuis apres (SHA-256 et mtime) : aucun second import"), intacte.sortie);
    assert.ok(intacte.sortie.includes("✓ import-report.json inchangé depuis apres"), intacte.sortie);
    assert.equal(intacte.status, 1, intacte.sortie);
    assert.ok(intacte.sortie.includes("✗ Qdrant redémarré à la main et joignable"), intacte.sortie);

    // Un second import réécrit le rapport : rouge avant toute lecture de Qdrant.
    fs.writeFileSync(path.join(ctx.racine, "stack", "podman-migration", "import-report.json"), '{"agents":[],"totaux":{"importes":0}}\n');
    const reimport = await recette("relance", ctx, service.port);
    assert.equal(reimport.status, 1, reimport.sortie);
    assert.ok(reimport.sortie.includes("✗ import-report.json inchangé depuis apres (SHA-256 et mtime)"), reimport.sortie);
    assert.ok(!reimport.sortie.includes("Qdrant"), reimport.sortie);
  } finally {
    await service.fermer();
  }
});

test("omp-console-sans-podman/AC-12 : la recette apres lit les souvenirs migrés avec le seul jeton X-Mem0-Token de stack/env, et rougit si le service exige un autre jeton", async () => {
  const ctx = racineBasculee();
  const memeJeton = await fauxService(() => SOUVENIRS);
  try {
    const vert = await recette("apres", ctx, memeJeton.port);
    assert.equal(vert.status, 0, vert.sortie);
  } finally {
    await memeJeton.fermer();
  }
  const autreJeton = await fauxService(() => SOUVENIRS, "un-autre-jeton");
  try {
    const rouge = await recette("apres", ctx, autreJeton.port);
    assert.equal(rouge.status, 1, rouge.sortie);
    assert.ok(rouge.sortie.includes("✗ GET /memory/all sur 127.0.0.1:"), rouge.sortie);
    assert.ok(rouge.sortie.includes("statut 401"), rouge.sortie);
  } finally {
    await autreJeton.fermer();
  }
});

/** Noms du podman embarqué qui ne survivent ni à la migration ni au nettoyage. */
const RESTES_PODMAN = [
  "MemoryUnion",
  "LegacyStack",
  "STACK_FINGERPRINT",
  "stack-fingerprint",
  "omp-console/stack/mem0-http",
  "Stack/mem0-http",
  "MemoryStack",
  "StackSources",
  "StackBuildContext",
  "DockerSocket",
  "podman-installer-macos",
  "installPodman",
  "pkgutil",
  "machineInit",
  "imageBuild",
  "MEM0_STACK_RECIPE",
  "MEM0_UNION_RECIPE",
  "MEM0_MIGRATION_RECIPE",
];

test("omp-console-sans-podman/AC-11 : aucun reste du podman embarqué hors migration et nettoyage", () => {
  const ceFichier = path.relative(ROOT, fileURLToPath(import.meta.url)).split(path.sep).join("/");
  const liste = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(liste.status, 0, `git ls-files a échoué : ${liste.stderr}`);
  const fichiers = liste.stdout
    .split("\0")
    .filter((f) => f !== "" && !f.startsWith(".omp/") && f !== "CHANGELOG.md" && f !== ceFichier)
    .filter((f) => fs.statSync(path.join(ROOT, f), { throwIfNoEntry: false })?.isFile() === true)
    .sort();
  assert.ok(fichiers.length > 0, "git ls-files ne liste aucun fichier");

  const trouvees: string[] = [];
  for (const fichier of fichiers) {
    const contenu = fs.readFileSync(path.join(ROOT, fichier));
    if (contenu.includes(0)) continue; // binaire
    if (!RESTES_PODMAN.some((motif) => contenu.includes(motif))) continue;
    contenu
      .toString("utf8")
      .split("\n")
      .forEach((ligne, index) => {
        for (const motif of RESTES_PODMAN) {
          if (ligne.includes(motif)) trouvees.push(`${fichier}:${index + 1} ${motif}`);
        }
      });
  }
  assert.deepEqual(trouvees, [], `restes du podman embarqué :\n${trouvees.join("\n")}`);
});
