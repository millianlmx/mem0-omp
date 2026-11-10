// Feature appairage-qr-apps : les apps Mac et iOS appairent un iPhone par QR code. Le Mac crée un ticket à
// usage unique (`POST /v1/pair/tickets`) et l'affiche en QR code `ompconsole://pair?u=<adresse>&t=<ticket>` ;
// l'iPhone l'ouvre, CONFIRME en nommant le serveur, puis l'échange SANS jeton (`POST /v1/pair/redeem`) contre
// le jeton d'un client nommé. Le serveur est gardé par test/harness/appairage-qr.test.ts ; ce fichier garde le
// client Swift : ses champs sont ceux du JSON réel, ses routes sont servies, l'échange est public, et aucun lien
// ne relie l'appareil sans que l'humain ait vu l'adresse.
//
// Chaque test vérifie d'abord l'arbre réel, puis plante une faute EN MÉMOIRE et vérifie que la garde la voit.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { API_FEATURES, apiRoutes, createHandler } from "../../omp-harness/http.ts";
import { fakeWorld } from "../support/harness-fixtures.ts";
import { ROOT, tmpdir } from "../support/repo.ts";

const read = (...parts: string[]) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

const LINK = "omp-console/Sources/ConsoleClient/HarnessPairLink.swift";
const MODEL = "omp-console/Sources/ConsoleClient/HarnessModel.swift";
const VIEWS = "omp-console/Sources/ConsoleUI/PairDeviceViews.swift";
const QR = "omp-console/Sources/ConsoleUI/PairQRCode.swift";
const IOS_ROOT = "omp-console/ios/OMPConsoleIOS/RootView.swift";
const MAC_ROOT = "omp-console/Sources/OMPConsole/ConsoleRootView.swift";
const MAC_SHEET = "omp-console/Sources/OMPConsole/Server/ServerSheet.swift";

/** Les sources d'une couche, relues à chaque test (les fautes se plantent sur la copie en mémoire). */
const sources = (...files: string[]): Map<string, string> => new Map(files.map((file) => [file, read(file)]));

/** Les champs `var nom: Type` d'une struct Swift (privée ou non), nom → optionnel ? */
function structFields(source: string, struct: string): Map<string, boolean> {
  const start = source.search(new RegExp(`struct ${struct}\\b[^{]*\\{`));
  assert.ok(start >= 0, `struct ${struct} introuvable`);
  const body = source.slice(start, source.indexOf("\n}\n", start));
  const fields = new Map<string, boolean>();
  for (const [, name, type] of body.matchAll(/^ {4}(?:public )?var (\w+): ([^\s{=]+)\s*$/gm))
    fields.set(name as string, (type as string).endsWith("?"));
  assert.ok(fields.size > 0, `aucun champ lu dans ${struct}`);
  return fields;
}

const LEGACY = "t".repeat(64);

/** Le harness derrière une vraie API ; `call` sans jeton quand `token` est `null`. */
async function pairWorld() {
  const world = fakeWorld(
    {},
    {
      patch: (config) => {
        config.issues.pollSec = null;
      },
    },
  );
  const clients = new ClientRegistry(path.join(tmpdir("appairage-qr-apps-"), "clients.json"), LEGACY);
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients }));
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (route: string, token: string | null, body: unknown) => {
    const response = await fetch(`${url}${route}`, {
      method: "POST",
      headers: { ...(token === null ? {} : { Authorization: `Bearer ${token}` }), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return {
    call,
    close: async () => {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
      await world.orchestrator.stop();
    },
  };
}

test("appairage-qr-apps/AC-1 : chaque champ du ticket et de l'échange décodé par le client Swift existe dans le JSON RÉEL du serveur", async () => {
  const link = read(LINK);
  const ticket = structFields(link, "HarnessPairTicket");
  const redeemed = structFields(link, "HarnessRedeemed");
  const memory = structFields(link, "HarnessPairMemory");
  assert.deepEqual([...ticket.keys()].sort(), ["approver", "ticket", "ttlSec"]);
  assert.deepEqual([...redeemed.keys()].sort(), ["client", "memory", "token"]);
  assert.deepEqual([...memory.keys()].sort(), ["token", "url"]);
  assert.equal(redeemed.get("memory"), true, "la mémoire jointe est facultative (null côté serveur)");

  const api = await pairWorld();
  try {
    const created = await api.call("/v1/pair/tickets", LEGACY, {
      label: "iPhone",
      memory: { url: "https://vps.example:8443", token: "memoire" },
    });
    assert.equal(created.status, 201);
    for (const name of ticket.keys()) assert.ok(name in created.body, `ticket.${name} : le serveur ne l'envoie pas`);
    assert.equal(typeof created.body.expiresAt, "number", "l'échéance du serveur est en millisecondes");
    const answer = await api.call("/v1/pair/redeem", null, { ticket: created.body.ticket });
    assert.equal(answer.status, 200);
    for (const name of redeemed.keys()) assert.ok(name in answer.body, `redeem.${name} : le serveur ne l'envoie pas`);
    assert.deepEqual(Object.keys(answer.body.memory as object).sort(), [...memory.keys()].sort());
    // Le client décodé : `HarnessClient` lit name, role, repos et approver.
    const client = answer.body.client as Record<string, unknown>;
    for (const name of ["name", "role", "repos", "approver"]) assert.ok(name in client, `client.${name}`);

    // Les corps que le client envoie sont ceux que le serveur lit : label, approver, memory ; ticket.
    for (const key of ["label", "approver", "memory"])
      assert.match(link, new RegExp(`var ${key}: `), `PairTicketBody.${key}`);
    assert.match(link, /struct RedeemBody: Encodable \{\s*var ticket: String/);
  } finally {
    await api.close();
  }
});

/** Les fautes de routes : la création est servie en admin, l'échange est hors du routeur et sans jeton. */
function routeFaults(files: Map<string, string>, redeemPath: string, features: readonly string[]): string[] {
  const faults: string[] = [];
  const link = files.get(LINK) ?? "";
  const model = files.get(MODEL) ?? "";
  const served = apiRoutes({ store: {} } as never, new ClientRegistry(null, LEGACY));
  const create = /"POST", "(\/v1\/pair\/tickets)"/.exec(link)?.[1];
  if (!create) faults.push(`${LINK} : la création du ticket n'appelle plus POST /v1/pair/tickets`);
  else if (served.find((route) => route.method === "POST" && route.pattern.test(create))?.role !== "admin")
    faults.push(`le serveur ne sert pas POST ${create} aux admins`);
  const redeem = /static let redeemPath = "([^"]+)"/.exec(link)?.[1];
  if (redeem !== redeemPath)
    faults.push(`${LINK} : redeemPath ${redeem ?? "absent"} ≠ la route publique du serveur ${redeemPath}`);
  if (served.some((route) => route.pattern.test(redeemPath)))
    faults.push(`${redeemPath} est dans apiRoutes : elle ne serait plus publique`);
  const call = /HarnessCall\(method: "POST", path: HarnessPairLink\.redeemPath[^)]*\)/.exec(link)?.[0] ?? "";
  if (!/authenticated: false/.test(call)) faults.push(`${LINK} : l'échange ne déclare plus authenticated: false`);
  for (const [file, source] of files) {
    if (file !== LINK && source.includes(redeemPath))
      faults.push(`${file} cite ${redeemPath} : l'appel public vit dans ${LINK}`);
  }
  if (model.includes("/v1/pair/"))
    faults.push(`${MODEL} cite une route d'appairage (la garde serveur-de-pipelines la jugerait)`);
  const feature = /static let pairingFeature = "([^"]+)"/.exec(link)?.[1];
  if (!feature || !features.includes(feature))
    faults.push(`${LINK} : la capacité ${feature ?? "absente"} n'est pas annoncée par le serveur`);
  const transport = files.get("omp-console/Sources/ConsoleClient/HarnessTransport.swift") ?? "";
  if (!/if call\.authenticated \{ request\.setValue\("Bearer/.test(transport))
    faults.push("HarnessTransport.swift : l'en-tête Bearer n'est plus conditionné par call.authenticated");
  return faults;
}

test("appairage-qr-apps/AC-2 : la création est servie en admin, l'échange est public (hors routeur, sans Authorization) et vit dans son fichier ; la capacité est annoncée", () => {
  const redeemPath = /const REDEEM_PATH = "([^"]+)"/.exec(read("omp-harness", "http.ts"))?.[1] ?? "";
  assert.ok(redeemPath, "REDEEM_PATH introuvable dans http.ts");
  const files = sources(
    LINK,
    MODEL,
    VIEWS,
    IOS_ROOT,
    MAC_SHEET,
    "omp-console/Sources/ConsoleClient/HarnessTransport.swift",
  );
  assert.deepEqual(routeFaults(files, redeemPath, API_FEATURES), []);

  const plant = (file: string, from: string, to: string) => {
    const copy = new Map(files);
    const source = copy.get(file) ?? "";
    assert.ok(source.includes(from), `faute impossible à planter : « ${from} »`);
    copy.set(file, source.replace(from, to));
    return routeFaults(copy, redeemPath, API_FEATURES);
  };
  assert.ok(plant(LINK, "authenticated: false", "authenticated: true").some((f) => /authenticated: false/.test(f)));
  assert.ok(
    plant(LINK, '"/v1/pair/tickets"', '"/v1/pair/ticket"').length > 0,
    "une route de création inconnue du serveur",
  );
  assert.ok(
    plant(MODEL, "public final class HarnessModel", `// ${redeemPath}\npublic final class HarnessModel`).length > 0,
    "l'appel public cité dans HarnessModel.swift",
  );
  assert.ok(plant(IOS_ROOT, "askToPair(url)", `askToPair(url) // ${redeemPath}`).length > 0, "cité dans un écran");
  assert.ok(plant(LINK, 'pairingFeature = "pairing-ticket"', 'pairingFeature = "pairing"').length > 0);
});

/** Les fautes du lien : le schéma et l'hôte sont ceux que l'appareil photo ouvre, les champs ceux du serveur. */
function linkFaults(files: Map<string, string>, plists: readonly string[]): string[] {
  const faults: string[] = [];
  const link = files.get(LINK) ?? "";
  if (!/static let host = "pair"/.test(link)) faults.push(`${LINK} : l'hôte du lien n'est plus « pair »`);
  if (!/addressField = "u"/.test(link) || !/ticketField = "t"/.test(link))
    faults.push(`${LINK} : les champs ne sont plus u et t`);
  if (!/HarnessModel\.normalizedAddress\(address\)/.test(link))
    faults.push(`${LINK} : l'adresse n'est plus normalisée comme la saisie`);
  if (!/addresses\.count == 1, tickets\.count == 1/.test(link))
    faults.push(`${LINK} : un champ répété n'est plus refusé`);
  if (!/percentEncodedQuery/.test(link)) faults.push(`${LINK} : le lien n'encode plus ses valeurs en pourcentage`);
  for (const plist of plists) {
    const text = files.get(plist) ?? "";
    if (!/<key>CFBundleURLSchemes<\/key>\s*<array>\s*<string>ompconsole<\/string>/.test(text))
      faults.push(`${plist} : le schéma ompconsole n'est plus déclaré`);
  }
  return faults;
}

test("appairage-qr-apps/AC-3 : le lien est ompconsole://pair?u=<adresse>&t=<ticket>, le schéma est déclaré par les deux apps et le serveur documente le même lien", () => {
  const plists = ["omp-console/Bundle/Info.plist", "omp-console/ios/OMPConsoleIOS-Info.plist"];
  const files = sources(LINK, ...plists);
  assert.deepEqual(linkFaults(files, plists), []);
  assert.match(
    read("omp-harness", "pairing.ts"),
    /ompconsole:\/\/pair\?u=<adresse>&t=<ticket>/,
    "le serveur documente un autre lien",
  );
  assert.equal(
    /static let scheme = "([^"]+)"/.exec(read("omp-console/Sources/ConsoleClient/HarnessWidget.swift"))?.[1],
    "ompconsole",
  );

  const plant = (from: string, to: string, file = LINK) => {
    const copy = new Map(files);
    copy.set(file, (copy.get(file) ?? "").replace(from, to));
    return linkFaults(copy, plists);
  };
  assert.ok(plant('host = "pair"', 'host = "appairer"').length > 0);
  assert.ok(plant('ticketField = "t"', 'ticketField = "ticket"').length > 0);
  assert.ok(plant("addresses.count == 1, tickets.count == 1", "addresses.count >= 1, tickets.count >= 1").length > 0);
  assert.ok(plant("percentEncodedQuery", "query").length > 0);
  assert.ok(plant("<string>ompconsole</string>", "<string>autre</string>", plists[1]).length > 0);
});

/** Les fautes de câblage : jamais d'échange avant la confirmation, le Mac ignore le lien, la feuille est gardée. */
function wiringFaults(files: Map<string, string>): string[] {
  const faults: string[] = [];
  const views = files.get(VIEWS) ?? "";
  const ios = files.get(IOS_ROOT) ?? "";
  const mac = files.get(MAC_ROOT) ?? "";
  const sheet = files.get(MAC_SHEET) ?? "";
  // L'échange n'a lieu que dans le bouton de la confirmation : un seul appel `pair(with:` dans toutes les vues.
  let calls = 0;
  for (const [file, source] of files) {
    if (file.startsWith("omp-console/Sources/ConsoleClient/")) continue;
    calls += source.split(/\.pair\(with:/).length - 1;
  }
  if (calls !== 1) faults.push(`${calls} appels de pair(with:) dans les écrans : un seul, celui de la confirmation`);
  if (!/Button\(PairingText\.confirm\) \{ Task \{ await pair\(link\) \} \}/.test(views))
    faults.push(`${VIEWS} : l'échange ne part plus du bouton « Appairer »`);
  if (!/confirmTitle\(address: \$0\.address\)/.test(views))
    faults.push(`${VIEWS} : la confirmation ne nomme plus le serveur`);
  if (/pairRequest = link\s*\n\s*Task/.test(ios) || /pair\(with:/.test(ios))
    faults.push(`${IOS_ROOT} : un lien ne doit qu'ouvrir la confirmation`);
  const open = ios.indexOf("HarnessPairLink.isPairLink(url)");
  const widget = ios.indexOf("HarnessWidgetLink.destination(of: url)");
  if (open < 0 || widget < 0 || open > widget)
    faults.push(`${IOS_ROOT} : le lien d'appairage doit être traité avant ceux des widgets`);
  if (!/drafts\.pairRequest = link/.test(ios) || !/\.invalidLink/.test(ios))
    faults.push(`${IOS_ROOT} : confirmation ou lien illisible absents`);
  if (!/\.pairLinkConfirmation\(server: server, drafts: drafts\)/.test(ios))
    faults.push(`${IOS_ROOT} : la confirmation n'est pas posée à la racine`);
  // La racine est UNE pour les deux interfaces : aucun autre onOpenURL de l'iPhone ne doit dépendre de l'interface.
  if (!/guard !HarnessPairLink\.isPairLink\(url\)/.test(mac))
    faults.push(`${MAC_ROOT} : le Mac n'ignore plus explicitement le lien d'appairage`);
  if (!/if server\.canCreatePairInvite \{/.test(sheet))
    faults.push(`${MAC_SHEET} : la rangée n'est plus gardée par canCreatePairInvite`);
  if (!/PairDeviceSheet\(server: server, memory:/.test(sheet))
    faults.push(`${MAC_SHEET} : la feuille n'est plus ouverte depuis la feuille Serveur`);
  if (!/if server\.canPairApprover \{/.test(views))
    faults.push(`${VIEWS} : l'interrupteur approbateur n'est plus réservé à l'approbateur`);
  return faults;
}

test("appairage-qr-apps/AC-4 : aucun lien ne relie l'appareil avant la confirmation qui nomme le serveur ; le Mac ignore le lien ; la feuille du Mac est gardée par la capacité", () => {
  const files = sources(LINK, MODEL, VIEWS, IOS_ROOT, MAC_ROOT, MAC_SHEET);
  files.set(
    "omp-console/ios/OMPConsoleIOS/IOSServerSheet.swift",
    read("omp-console/ios/OMPConsoleIOS/IOSServerSheet.swift"),
  );
  assert.deepEqual(wiringFaults(files), []);

  const plant = (file: string, from: string, to: string) => {
    const copy = new Map(files);
    const source = copy.get(file) ?? "";
    assert.ok(source.includes(from), `faute impossible à planter : « ${from} »`);
    copy.set(file, source.replace(from, to));
    return wiringFaults(copy);
  };
  assert.ok(
    plant(IOS_ROOT, "drafts.pairRequest = link", "Task { _ = await server.pair(with: link) }").length > 0,
    "échange direct sur lien",
  );
  assert.ok(
    plant(VIEWS, "confirmTitle(address: $0.address)", 'confirmTitle(address: "")').length > 0,
    "confirmation anonyme",
  );
  assert.ok(
    plant(MAC_ROOT, "guard !HarnessPairLink.isPairLink(url), let", "guard let").length > 0,
    "Mac sans garde explicite",
  );
  assert.ok(plant(MAC_SHEET, "if server.canCreatePairInvite {", "if true {").length > 0, "rangée sans capacité");
  assert.ok(
    plant(VIEWS, "if server.canPairApprover {", "if true {").length > 0,
    "interrupteur approbateur offert à tous",
  );
});

/** Les fautes du dessin : CoreImage, correction M, agrandi sans lissage, noir sur blanc, image décorative. */
function qrFaults(files: Map<string, string>): string[] {
  const faults: string[] = [];
  const qr = files.get(QR) ?? "";
  const views = files.get(VIEWS) ?? "";
  if (!/CIFilter\.qrCodeGenerator\(\)/.test(qr)) faults.push(`${QR} : le générateur de QR code de CoreImage a disparu`);
  if (!/correctionLevel = "M"/.test(qr)) faults.push(`${QR} : la correction d'erreur n'est plus M`);
  if (!/samplingNearest\(\)/.test(qr)) faults.push(`${QR} : l'agrandissement n'est plus sans lissage`);
  if (!/CIImage\(color: \.white\)/.test(qr)) faults.push(`${QR} : le fond n'est plus blanc quel que soit le mode`);
  if (!/Image\(decorative: code, scale: 1\)/.test(views) || !/\.interpolation\(\.none\)/.test(views))
    faults.push(`${VIEWS} : le QR code n'est plus une image décorative sans interpolation`);
  if (!/\.accessibilityLabel\(PairingText\.codeLabel\)/.test(views))
    faults.push(`${VIEWS} : le QR code n'a plus d'étiquette VoiceOver`);
  for (const file of [QR, VIEWS]) {
    if (/import (AppKit|UIKit)\b/.test(files.get(file) ?? ""))
      faults.push(`${file} : ConsoleUI n'importe ni AppKit ni UIKit`);
  }
  return faults;
}

test("appairage-qr-apps/AC-5 : le QR code est dessiné par CoreImage (correction M, sans lissage, noir sur blanc), décoratif, avec une étiquette VoiceOver, sans AppKit ni UIKit", () => {
  const files = sources(QR, VIEWS);
  assert.deepEqual(qrFaults(files), []);
  const plant = (file: string, from: string, to: string) => {
    const copy = new Map(files);
    const source = copy.get(file) ?? "";
    assert.ok(source.includes(from), `faute impossible à planter : « ${from} »`);
    copy.set(file, source.replace(from, to));
    return qrFaults(copy);
  };
  assert.ok(plant(QR, 'correctionLevel = "M"', 'correctionLevel = "L"').length > 0);
  assert.ok(plant(QR, "samplingNearest()", "").length > 0);
  assert.ok(plant(QR, "CIImage(color: .white)", "CIImage(color: .clear)").length > 0);
  assert.ok(plant(VIEWS, ".interpolation(.none)", "").length > 0);
  assert.ok(plant(VIEWS, ".accessibilityLabel(PairingText.codeLabel)", "").length > 0);
  assert.ok(plant(VIEWS, "import SwiftUI", "import SwiftUI\nimport UIKit").length > 0);
});
