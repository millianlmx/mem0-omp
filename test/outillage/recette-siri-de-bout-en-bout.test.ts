// Feature recette-siri-de-bout-en-bout : la liste attendue unique des intents
// Siri (scripts/app-intents/attendus.json), contrôlée à l'assemblage des deux
// bundles, et la recette vocale de bout en bout du README d'omp-console.
//
// AC-7 : prouvé par les tests AC-1 à AC-5 ci-dessous, chacun sur le bundle Mac ET sur l'app iOS
//
// Les tests exécutent les VRAIS scripts/swift-app.sh et scripts/ios-build.sh dans
// des copies jetables, avec les doublures de test/support/ : aucun outil Apple réel
// n'est requis. Chaque écart part du `extract.actionsdata` conforme
// (`actionsData(bundle)`), et les intents ou phrases qu'il modifie sont CALCULÉS
// depuis la liste attendue : aucun nom d'intent ni aucune phrase n'est écrit ici.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT, tmpdir } from "../support/repo.ts";
import { actionsData, readAttendus } from "../support/app-intents-doubles.ts";
import type { Bundle } from "../support/app-intents-doubles.ts";
import { META_ACTIONS_REL, montageAppIntents, signaturesDuBundle } from "../support/swift-app-doubles.ts";
import { montageIosBuild } from "../support/ios-build-doubles.ts";

const BUNDLES: Bundle[] = ["mac", "ios"];
const LIBELLE: Record<Bundle, string> = { mac: "Mac", ios: "iOS" };
const ATTENDUS_REL = "scripts/app-intents/attendus.json";
const NON_CONFORME: Record<Bundle, string> = {
  mac: `✗ Metadata.appintents non conforme à ${ATTENDUS_REL} (bundle Mac)`,
  ios: `✗ Metadata.appintents de l'app iOS non conforme à ${ATTENDUS_REL}`,
};

type ActionsData = {
  actions: Record<string, { identifier: string }>;
  autoShortcuts: { actionIdentifier: string; phraseTemplates: { key: string }[] }[];
};

const pluriel = (n: number, mot: string) => `${n} ${mot}${n === 1 ? "" : "s"}`;

function ligneConforme(bundle: Bundle): string {
  const intents = readAttendus()[bundle];
  const phrases = Object.values(intents).reduce((total, liste) => total + liste.length, 0);
  return `  ✓ intents Siri conformes à ${ATTENDUS_REL} (bundle ${LIBELLE[bundle]} : ${pluriel(Object.keys(intents).length, "intent")}, ${pluriel(phrases, "phrase")})`;
}

const intentAbsent = (b: Bundle, type: string) =>
  `  ✗ intent attendu absent du bundle ${LIBELLE[b]} : ${type} introuvable dans extract.actionsdata`;
const phraseAbsente = (b: Bundle, type: string, phrase: string) =>
  `  ✗ phrase attendue absente du bundle ${LIBELLE[b]} : « ${phrase} » (intent ${type}) introuvable dans extract.actionsdata`;
const intentNonListe = (b: Bundle, type: string) =>
  `  ✗ intent non listé dans le bundle ${LIBELLE[b]} : ${type} — à ajouter à ${ATTENDUS_REL}`;
const phraseNonListee = (b: Bundle, type: string, phrase: string) =>
  `  ✗ phrase non listée dans le bundle ${LIBELLE[b]} : « ${phrase} » (intent ${type}) — à ajouter à ${ATTENDUS_REL}`;
const phraseSansNom = (b: Bundle, type: string, phrase: string) =>
  `  ✗ phrase sans \${applicationName} dans le bundle ${LIBELLE[b]} : « ${phrase} » (intent ${type})`;

/** Le `extract.actionsdata` conforme du bundle, modifié par `modifier`, écrit dans un fichier jetable. */
function ecart(bundle: Bundle, modifier: (data: ActionsData) => void): string {
  const data = JSON.parse(actionsData(bundle)) as ActionsData;
  modifier(data);
  const fichier = path.join(tmpdir(`recette-ecart-${bundle}-`), "extract.actionsdata");
  fs.writeFileSync(fichier, JSON.stringify(data));
  return fichier;
}

function ajouterPhrase(data: ActionsData, type: string, phrase: string): void {
  const raccourci = data.autoShortcuts.find((r) => r.actionIdentifier === type);
  assert.ok(raccourci, `${type} n'a pas d'App Shortcut dans la doublure`);
  raccourci.phraseTemplates.push({ key: phrase });
}

/**
 * Lance l'assemblage COMPLET du bundle sur `extract.actionsdata` doublé (et une
 * liste attendue modifiée par `liste`, si donnée), puis prouve l'échec : code 1,
 * lignes attendues sur stderr, ligne finale du script ; Mac sans bundle ni
 * signature, iOS sans aucun `xcodebuild test`. Rend stderr.
 */
function prouverEchec(
  bundle: Bundle,
  env: Record<string, string>,
  attendues: string[],
  liste?: (attendus: Record<Bundle, Record<string, string[]>>) => void,
): string {
  const reecrire = (racine: string) => {
    if (!liste) return;
    const fichier = path.join(racine, ATTENDUS_REL);
    const attendus = JSON.parse(fs.readFileSync(fichier, "utf8")) as Record<Bundle, Record<string, string[]>>;
    liste(attendus);
    fs.writeFileSync(fichier, `${JSON.stringify(attendus, null, 2)}\n`);
  };
  let status: number | null;
  let stderr: string;
  let sortie: string;
  if (bundle === "mac") {
    const { copie, bundle: app, lancer, planterAncienBundle } = montageAppIntents();
    reecrire(copie);
    planterAncienBundle();
    const r = lancer([], env);
    ({ status, stderr, sortie } = r);
    assert.ok(!fs.existsSync(app), `[Mac] un bundle a survécu à l'échec : ${app}\n${sortie}`);
    assert.deepEqual(signaturesDuBundle(r.lignes, app), [], `[Mac] le bundle a été signé malgré l'échec\n${sortie}`);
  } else {
    const { root, journal, run } = montageIosBuild();
    reecrire(root);
    const r = run([], env);
    status = r.status;
    stderr = r.stderr ?? "";
    sortie = `${r.stdout ?? ""}${stderr}`;
    const lignes = fs.existsSync(journal) ? fs.readFileSync(journal, "utf8") : "";
    assert.ok(!/^xcodebuild test\b/m.test(lignes), `[iOS] xcodebuild test lancé malgré l'échec\n${lignes}`);
  }
  const b = LIBELLE[bundle];
  assert.equal(status, 1, `[${b}] ${sortie}`);
  for (const ligne of [...attendues, NON_CONFORME[bundle]]) {
    assert.ok(stderr.includes(ligne), `[${b}] ligne absente : ${ligne}\n${sortie}`);
  }
  assert.ok(!sortie.includes("✓ intents Siri conformes"), `[${b}] ligne ✓ affichée malgré l'échec\n${sortie}`);
  return stderr;
}

test("recette-siri-de-bout-en-bout/AC-1 : sur la base conforme, l'assemblage Mac et la compilation iOS réussissent, --no-tests comme complet, et confirment les intents et phrases embarqués", () => {
  const mac = montageAppIntents();
  for (const args of [["--no-tests"], []]) {
    const voie = args.length === 0 ? "complet" : "--no-tests";
    const r = mac.lancer(args);
    assert.equal(r.status, 0, `[Mac ${voie}] ${r.sortie}`);
    assert.ok(
      r.sortie.includes(ligneConforme("mac")),
      `[Mac ${voie}] ligne ✓ absente : ${ligneConforme("mac")}\n${r.sortie}`,
    );
    assert.equal(
      fs.readFileSync(path.join(mac.bundle, META_ACTIONS_REL), "utf8"),
      actionsData("mac"),
      `[Mac ${voie}] extract.actionsdata du bundle`,
    );
    assert.ok(
      r.lignes.includes(`codesign --force --sign - ${mac.bundle} meta=oui`),
      `[Mac ${voie}] bundle non signé\n${r.lignes.join("\n")}`,
    );
  }

  const ios = montageIosBuild();
  for (const args of [["--no-tests"], []]) {
    const voie = args.length === 0 ? "complet" : "--no-tests";
    const r = ios.run(args);
    const sortie = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 0, `[iOS ${voie}] ${sortie}`);
    assert.ok(
      r.stdout.includes(ligneConforme("ios")),
      `[iOS ${voie}] ligne ✓ absente : ${ligneConforme("ios")}\n${sortie}`,
    );
    if (voie === "complet") {
      assert.ok(sortie.includes("tests non exécutés : aucun simulateur iOS 26 disponible"), `[iOS complet] ${sortie}`);
    }
  }
});

test("recette-siri-de-bout-en-bout/AC-2 : un intent attendu absent du bundle fait échouer l'assemblage en le nommant", () => {
  for (const bundle of BUNDLES) {
    const [type] = Object.entries(readAttendus()[bundle]).find(([, phrases]) => phrases.length > 0) ?? [];
    assert.ok(type, `${bundle} : aucun intent avec phrase dans la liste`);
    const fichier = ecart(bundle, (data) => {
      delete data.actions[type];
      data.autoShortcuts = data.autoShortcuts.filter((r) => r.actionIdentifier !== type);
    });
    prouverEchec(bundle, { FAUX_ACTIONSDATA: fichier }, [intentAbsent(bundle, type)]);
  }
});

test("recette-siri-de-bout-en-bout/AC-3 : une phrase d'App Shortcut attendue absente du bundle fait échouer l'assemblage en la citant", () => {
  for (const bundle of BUNDLES) {
    const [type, phrases] = Object.entries(readAttendus()[bundle]).find(([, liste]) => liste.length >= 2) ?? [];
    assert.ok(type && phrases, `${bundle} : aucun intent à deux phrases dans la liste`);
    const phrase = phrases[phrases.length - 1];
    const fichier = ecart(bundle, (data) => {
      for (const r of data.autoShortcuts) {
        if (r.actionIdentifier === type) r.phraseTemplates = r.phraseTemplates.filter((g) => g.key !== phrase);
      }
    });
    prouverEchec(bundle, { FAUX_ACTIONSDATA: fichier }, [phraseAbsente(bundle, type, phrase)]);
  }
});

test("recette-siri-de-bout-en-bout/AC-4 : un intent ou une phrase non listé dans le bundle fait échouer l'assemblage en le nommant", () => {
  const intrus = "RecetteIntruseIntent";
  const phrase = "Intruse dans ${applicationName}";
  for (const bundle of BUNDLES) {
    const [premier] = Object.keys(readAttendus()[bundle]);
    const avecIntent = ecart(bundle, (data) => {
      data.actions[intrus] = { identifier: intrus };
    });
    prouverEchec(bundle, { FAUX_ACTIONSDATA: avecIntent }, [intentNonListe(bundle, intrus)]);
    const avecPhrase = ecart(bundle, (data) => ajouterPhrase(data, premier, phrase));
    prouverEchec(bundle, { FAUX_ACTIONSDATA: avecPhrase }, [phraseNonListee(bundle, premier, phrase)]);
  }
});

test("recette-siri-de-bout-en-bout/AC-5 : une phrase du bundle sans ${applicationName} fait échouer l'assemblage en la citant", () => {
  const phrase = "Phrase sans nom";
  for (const bundle of BUNDLES) {
    const [premier] = Object.keys(readAttendus()[bundle]);
    const fichier = ecart(bundle, (data) => ajouterPhrase(data, premier, phrase));
    const stderr = prouverEchec(bundle, { FAUX_ACTIONSDATA: fichier }, [phraseSansNom(bundle, premier, phrase)]);
    assert.ok(
      !stderr.includes(phraseNonListee(bundle, premier, phrase)),
      `[${LIBELLE[bundle]}] E-P2 émis pour une phrase sans nom\n${stderr}`,
    );
  }
});

test("recette-siri-de-bout-en-bout/AC-6 : la liste attendue n'existe qu'à un seul endroit, lu par les deux scripts, et un intent qui en sort fait rougir les deux assemblages", () => {
  const attendus = readAttendus();
  const support = path.join(ROOT, "test", "support");
  const fichiers = [
    "scripts/swift-app.sh",
    "scripts/ios-build.sh",
    "scripts/app-intents/controle.py",
    ...fs.readdirSync(support).map((nom) => path.join("test", "support", nom)),
  ];
  for (const script of ["scripts/swift-app.sh", "scripts/ios-build.sh"]) {
    assert.ok(
      fs.readFileSync(path.join(ROOT, script), "utf8").includes("scripts/app-intents/controle.py"),
      `${script} n'invoque pas le comparateur`,
    );
  }
  const types = BUNDLES.flatMap((b) => Object.keys(attendus[b]));
  const phrases = BUNDLES.flatMap((b) => Object.values(attendus[b]).flat());
  const fautes: string[] = [];
  for (const rel of fichiers) {
    const texte = fs.readFileSync(path.join(ROOT, rel), "utf8");
    for (const type of types)
      if (new RegExp(`\\b${type}\\b(?!\\.swift)`).test(texte)) fautes.push(`${rel} nomme ${type}`);
    for (const phrase of phrases) if (texte.includes(phrase)) fautes.push(`${rel} cite « ${phrase} »`);
  }
  assert.deepEqual(fautes, []);

  for (const bundle of BUNDLES) {
    const [type, retirees] = Object.entries(attendus[bundle])[0];
    prouverEchec(
      bundle,
      {},
      [intentNonListe(bundle, type), ...retirees.map((p) => phraseNonListee(bundle, type, p))],
      (copie) => {
        delete copie[bundle][type];
      },
    );
  }
});

// ---------------------------------------------------------------------------
// Recette vocale du README (BR-2, S-7).

const RECETTE = "### Siri : recette vocale de bout en bout";
const SUIVANTE = "### Conduire un projet depuis l'iPad";
const PREALABLES = "**Préalables (à la main, avant la première phrase)**";
const DEROULE = "**Déroulé (à la voix uniquement)**";
const SANS_CONTOURNEMENT =
  "Si la PR ne s'ouvre pas après l'acceptation vocale de la revue, consignez un écart au pas 6 et arrêtez la passe : aucun geste manuel ne la remplace.";

/** La section de la recette, de son titre jusqu'au prochain titre `^#{1,3} ` exclu, et ce titre suivant. */
function recette(): { corps: string; suivant: string | undefined } {
  const lignes = fs.readFileSync(path.join(ROOT, "omp-console", "README.md"), "utf8").split("\n");
  const debut = lignes.indexOf(RECETTE);
  assert.ok(debut >= 0, `section absente du README : ${RECETTE}`);
  const reste = lignes.slice(debut + 1);
  const fin = reste.findIndex((l) => /^#{1,3} /.test(l));
  return { corps: (fin < 0 ? reste : reste.slice(0, fin)).join("\n"), suivant: fin < 0 ? undefined : reste[fin] };
}

/** Les sous-sections `#### ` de la recette, par titre. */
function sousSections(corps: string): Map<string, string> {
  const parts = new Map<string, string>();
  for (const bloc of corps.split(/^#### /m).slice(1)) {
    const saut = bloc.indexOf("\n");
    parts.set(bloc.slice(0, saut), bloc.slice(saut + 1));
  }
  return parts;
}

const cellules = (ligne: string) =>
  ligne
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim());

test("recette-siri-de-bout-en-bout/AC-8 : le README décrit deux passes (iPhone puis Mac), avec préalables manuels, feature jetable, pas ordonnés, phrases de la liste attendue et grille « OK ou écart »", () => {
  const { corps, suivant } = recette();
  assert.equal(suivant, SUIVANTE, "la recette doit précéder immédiatement la conduite depuis l'iPad");
  const parts = sousSections(corps);
  assert.deepEqual(
    [...parts.keys()],
    ["Feature jetable", "Règles des deux passes", "Passe 1 — iPhone", "Passe 2 — Mac", "Consigner le résultat"],
  );

  const jetable = (parts.get("Feature jetable") ?? "")
    .split("\n")
    .filter((l) => l.startsWith("| "))
    .map(cellules);
  for (const passe of ["iPhone", "Mac"]) {
    const ligne = jetable.find((c) => c[0] === passe);
    assert.ok(ligne?.[1] && ligne[2], `feature jetable sans titre ni besoin pour la passe ${passe}`);
  }

  const attendus = readAttendus();
  const passes: { titre: string; bundle: Bundle; cites: string[]; intents: string[] }[] = [
    {
      titre: "Passe 1 — iPhone",
      bundle: "ios",
      cites: ["déverrouillé", "appairée", "La console Mac est ouverte et joignable", "Le dépôt de test est prêt"],
      intents: [
        "IOSLaunchFeatureIntent",
        "IOSPendingRequestsIntent",
        "IOSSessionPromptIntent",
        "IOSValidateSpecsIntent",
        "IOSAcceptReviewIntent",
        "IOSPendingRequestsIntent",
      ],
    },
    {
      titre: "Passe 2 — Mac",
      bundle: "mac",
      cites: ["déverrouillée", "La console Mac est ouverte et joignable", "Le dépôt de test est prêt"],
      intents: [
        "MacLaunchPipelineIntent",
        "MacAnswerIntent",
        "MacSessionPromptIntent",
        "MacValidateSpecsIntent",
        "MacAcceptReviewIntent",
        "MacPendingIntent",
      ],
    },
  ];
  for (const { titre, bundle, cites, intents } of passes) {
    const texte = parts.get(titre) ?? "";
    const iPrealables = texte.indexOf(PREALABLES);
    const iDeroule = texte.indexOf(DEROULE);
    assert.ok(iPrealables >= 0 && iDeroule > iPrealables, `[${titre}] préalables puis déroulé attendus`);
    const puces = texte
      .slice(iPrealables, iDeroule)
      .split("\n")
      .filter((l) => l.startsWith("- "));
    assert.ok(puces.length >= 4, `[${titre}] ${puces.length} préalable(s), 4 au moins attendus`);
    for (const cite of cites)
      assert.ok(texte.slice(iPrealables, iDeroule).includes(cite), `[${titre}] préalable absent : ${cite}`);

    const tableau = texte
      .slice(iDeroule)
      .split("\n")
      .filter((l) => l.startsWith("|"));
    assert.equal(
      tableau[0],
      "| Pas | Phrase à dire | Réponse attendue de Siri | OK ou écart |",
      `[${titre}] en-tête du déroulé`,
    );
    const pas = tableau.slice(2).map(cellules);
    assert.deepEqual(
      pas.map((c) => c[0]),
      [
        "1. Lancer",
        "2. Répondre à la question",
        "3. Dicter à la session OMP",
        "4. Valider les specs",
        "5. Accepter la revue",
        "6. PR ouverte",
      ],
      `[${titre}] pas du déroulé`,
    );
    pas.forEach((c, i) => {
      assert.equal(c.length, 4, `[${titre}] pas ${c[0]} : 4 cellules attendues`);
      assert.ok(c[2].length > 0, `[${titre}] pas ${c[0]} sans réponse attendue de Siri`);
      assert.equal(c[3], "", `[${titre}] pas ${c[0]} : la colonne « OK ou écart » doit être vide`);
      const phrase = /«\s*(.+?)\s*»/.exec(c[1])?.[1]?.replaceAll("OMP Console", "${applicationName}");
      assert.ok(
        phrase && attendus[bundle][intents[i]].includes(phrase),
        `[${titre}] pas ${c[0]} : « ${phrase} » n'est pas une phrase de ${intents[i]} dans la liste attendue`,
      );
    });
  }

  const consigner = parts.get("Consigner le résultat") ?? "";
  for (const champ of ["Date", "iOS", "macOS", "PR de la passe iPhone", "PR de la passe Mac"]) {
    assert.ok(consigner.includes(champ), `« Consigner le résultat » ne cite pas : ${champ}`);
  }
});

test("recette-siri-de-bout-en-bout/AC-11 : si la PR ne s'ouvre pas après l'acceptation vocale de la revue, la recette fait consigner un écart sans aucun geste de contournement", () => {
  const { corps } = recette();
  assert.equal(
    corps.split(SANS_CONTOURNEMENT).length - 1,
    1,
    "la consigne d'écart au pas 6 doit figurer exactement une fois",
  );
  for (const motif of ["gh pr create", "git push", "curl", "/v1/"]) {
    assert.ok(!corps.includes(motif), `la recette propose un contournement : ${motif}`);
  }
});
