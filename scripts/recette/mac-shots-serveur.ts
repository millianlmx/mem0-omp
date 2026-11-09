// Le serveur de DÉMONSTRATION de `scripts/recette/mac-shots.sh` : un vrai gestionnaire
// HTTP d'omp-harness (`createHandler`) sur un monde de test (`fakeWorld`), où une
// feature attend la validation de sa revue avec des preuves sur deux tours — le
// rapport de tests de /impl et une capture avant/après dans le premier, puis, après
// /impl --fix, un nouveau rapport, un avant/après, une capture seule et un journal.
// Les captures sont des PNG dessinés ici (aplats), jamais des captures inventées
// d'une vraie app.
//
// Sortie : UNE ligne JSON `{url, token, runId}` sur stdout, puis le serveur tourne
// jusqu'à SIGTERM/SIGINT. Usage : `node --experimental-strip-types
// scripts/recette/mac-shots-serveur.ts`.
import { randomBytes } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { crc32, deflateSync } from "node:zlib";
import { createHandler } from "../../omp-harness/http.ts";
import { ProofStore } from "../../omp-harness/proofs.ts";
import { tapTally } from "../../omp-harness/tap.ts";
import { testReport } from "../../omp-harness/test-report.ts";
import { fakeWorld } from "../../test/support/harness-fixtures.ts";

export const DEMO_RUN = "demo-preuves";

type Rect = { x: number; y: number; w: number; h: number; rgb: [number, number, number] };

/** Un PNG RGB de `width`×`height` : un fond et des rectangles pleins. */
export function drawPng(width: number, height: number, background: [number, number, number], rects: Rect[]): Buffer {
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    raw[y * row] = 0;
    for (let x = 0; x < width; x++) {
      const hit = rects.findLast((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
      const [red, green, blue] = hit ? hit.rgb : background;
      const at = y * row + 1 + x * 3;
      raw[at] = red;
      raw[at + 1] = green;
      raw[at + 2] = blue;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Une page de panier : l'en-tête, la liste, et un bouton d'export (absent de la base). */
function cartPage(withExport: boolean, accent: [number, number, number]): Buffer {
  const rects: Rect[] = [
    { x: 0, y: 0, w: 960, h: 70, rgb: [32, 41, 64] },
    { x: 40, y: 110, w: 560, h: 60, rgb: [230, 233, 240] },
    { x: 40, y: 190, w: 560, h: 60, rgb: [230, 233, 240] },
    { x: 40, y: 270, w: 560, h: 60, rgb: [230, 233, 240] },
  ];
  if (withExport) rects.push({ x: 660, y: 110, w: 240, h: 64, rgb: accent });
  return drawPng(960, 600, [248, 249, 252], rects);
}

/** Attend que l'horloge avance : deux preuves ou étapes n'ont jamais le même instant. */
function tick(): void {
  const start = Date.now();
  while (Date.now() <= start + 1) {
    // attente active de 2 ms au plus
  }
}

function report(step: "impl" | "fix", lines: string) {
  return testReport(
    {
      outcome: lines.includes("not ok") ? "fail" : "pass",
      exitCode: lines.includes("not ok") ? 1 : 0,
      output: lines,
      durationMs: 1200,
      attempts: 1,
      cached: false,
      skipped: false,
      note: null,
      tree: "demo",
      key: step,
      command: "node --test",
      tap: tapTally(lines),
    },
    "touched",
    step,
    { slugs: ["export-panier"], acIds: ["AC-1", "AC-2"] },
  );
}

/** Le monde de démonstration : la feature, ses étapes et ses preuves. */
export function demoWorld() {
  const world = fakeWorld({});
  const { store } = world;
  store.createRun({
    id: DEMO_RUN,
    repo: "demo",
    slug: "export-panier",
    title: "Export CSV du panier",
    request: "Ajouter un bouton qui exporte le panier en CSV.",
    branch: "harness/export-panier",
    state: "awaiting_human",
    step: "review",
  });
  store.updateRun(DEMO_RUN, {
    verdict: {
      risk: "low",
      summary: "Le bouton exporte le panier en CSV ; les deux critères passent.",
      blockers: [],
      risks: [],
      files: ["src/panier.ts"],
      unverified: [],
      criteria: [
        { id: "AC-1", test: "test/export-panier.test.ts", status: "pass" },
        { id: "AC-2", test: "test/export-panier.test.ts", status: "pass" },
      ],
      confidence: "strong",
    },
  });
  const proofs = new ProofStore(world.config.dataDir);
  const add = (input: Parameters<ProofStore["add"]>[1]) => {
    const added = proofs.add(DEMO_RUN, input);
    if (!added.ok) throw new Error(`preuve refusée : ${added.reason}`);
    tick();
  };
  const step = (kind: "impl" | "review" | "fix") => {
    const row = store.startStep(DEMO_RUN, kind, 0, null, null);
    tick();
    return row;
  };

  // Premier tour : /impl, puis une revue qui renvoie en correction.
  const impl = step("impl");
  const first = report("impl", "ok 1 - export-panier/AC-1 : a\nnot ok 2 - export-panier/AC-2 : b\nok 3 - autre : c\n");
  add({ kind: "test_report", title: first.title, step: "impl", mime: "application/json", data: first.data });
  store.finishStep(impl.id, "done", null);
  const review = step("review");
  add({
    kind: "screenshot",
    title: "Panier sans export",
    step: "review",
    mime: "image/png",
    data: cartPage(false, [0, 0, 0]),
    acRef: "AC-1",
    side: "before",
  });
  add({
    kind: "screenshot",
    title: "Bouton d’export mal placé",
    step: "review",
    mime: "image/png",
    data: cartPage(true, [214, 69, 65]),
    acRef: "AC-1",
    side: "after",
  });
  store.finishStep(review.id, "done", null);

  // Tour courant : /impl --fix, puis la revue qui attend la validation.
  const fix = step("fix");
  const second = report(
    "fix",
    "ok 1 - export-panier/AC-1 : a\nok 2 - export-panier/AC-2 : b\nok 3 - autre : c\nok 4 - autre : d\n",
  );
  add({ kind: "test_report", title: second.title, step: "fix", mime: "application/json", data: second.data });
  store.finishStep(fix.id, "done", null);
  const last = step("review");
  add({
    kind: "screenshot",
    title: "Panier de la base",
    step: "review",
    mime: "image/png",
    data: cartPage(false, [0, 0, 0]),
    acRef: "AC-1",
    side: "before",
  });
  add({
    kind: "screenshot",
    title: "Bouton « Exporter en CSV »",
    step: "review",
    mime: "image/png",
    data: cartPage(true, [46, 160, 90]),
    acRef: "AC-1",
    side: "after",
  });
  add({
    kind: "screenshot",
    title: "Panier vide",
    step: "review",
    mime: "image/png",
    data: drawPng(960, 600, [248, 249, 252], [{ x: 0, y: 0, w: 960, h: 70, rgb: [32, 41, 64] }]),
    acRef: "AC-2",
  });
  add({
    kind: "log",
    title: "Fichier exporté",
    step: "review",
    mime: "text/plain; charset=utf-8",
    data: Buffer.from("article;quantité;prix\nthé;2;7,80\n", "utf8"),
  });
  store.finishStep(last.id, "done", null);
  return world;
}

if (import.meta.main) {
  const world = demoWorld();
  const token = randomBytes(32).toString("hex");
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, token }));
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address() as AddressInfo;
    process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${port}`, token, runId: DEMO_RUN })}\n`);
  });
  const stop = () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
