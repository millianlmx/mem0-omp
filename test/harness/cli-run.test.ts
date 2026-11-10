// Feature cli-run : la CLI de script du harness (omp-harness/cli.ts). Lancer un run et l'attendre
// depuis un shell : le code de sortie dit où en est le run (0 livré, 1 échoué ou refusé, 2 ligne
// fausse, 3 attend un humain, 4 délai, 5 serveur injoignable), `--json` rend UN objet, le jeton ne
// sort jamais, une même `--key` porte la même `Idempotency-Key`. Le vrai binaire est lancé, contre
// un faux serveur HTTP local.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const CLI = path.resolve(import.meta.dirname, "../../omp-harness/cli.ts");
const TOKEN = `omp-${"s3cr3t".repeat(8)}`;

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };
type Answer = { status: number; body: unknown };
type Fake = { url: string; seen: Seen[]; close: () => Promise<void> };

const RUN_ID = "rabc123";

function run(state: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: RUN_ID, repo: "mon-produit", title: "Ajouter X", state, step: null, reason: null, rev: 1, ...extra };
}

/** Un faux serveur : `answer` rend la réponse à chaque requête, dans l'ordre où elles arrivent. */
async function serve(answer: (seen: Seen, index: number) => Answer): Promise<Fake> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const entry = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      };
      seen.push(entry);
      const { status, body } = answer(entry, seen.length - 1);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Un faux serveur de run : POST crée `queued`, les GET suivants rendent les vues de `views`, la dernière répétée. */
function runServer(views: { run: Record<string, unknown>; escalations?: unknown[] }[]): Promise<Fake> {
  let polls = 0;
  return serve((seen) => {
    if (seen.method === "POST") return { status: 201, body: { run: run("queued") } };
    const view = views[Math.min(polls, views.length - 1)];
    polls += 1;
    return { status: 200, body: { ...view, steps: [], decisions: [], artifacts: [] } };
  });
}

type Output = { code: number | null; stdout: string; stderr: string };

/** Le binaire, avec un dossier personnel jetable et la connexion de `env`. */
function cli(args: string[], options: { env?: Record<string, string>; stdin?: string | Buffer } = {}): Promise<Output> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cli-run-"));
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: home, ...options.env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.on("error", () => {});
  child.stdin.end(options.stdin);
  const { promise, resolve } = Promise.withResolvers<Output>();
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  child.on("close", (code) => {
    clearTimeout(timer);
    fs.rmSync(home, { recursive: true, force: true });
    resolve({ code, stdout, stderr });
  });
  return promise;
}

const connect = (fake: Fake): Record<string, string> => ({ HARNESS_URL: fake.url, HARNESS_TOKEN: TOKEN });
const RUN_ARGS = ["run", "--repo", "mon-produit", "--title", "Ajouter X", "--request", "Faire X"];

function only(output: Output): Record<string, unknown> {
  assert.equal(output.stderr, "", "en --json, stderr reste vide");
  const lines = output.stdout.split("\n").filter((line) => line !== "");
  assert.equal(lines.length, 1, `un seul objet JSON sur stdout : ${output.stdout}`);
  return JSON.parse(lines[0] as string);
}

test("cli-run/AC-1 : run sans --wait rend 0 et l'id dès que le run est créé, avec le corps de POST /v1/runs", async () => {
  const fake = await runServer([{ run: run("merged") }]);
  try {
    const out = await cli([...RUN_ARGS, "--lane", "full", "--priority", "3", "--budget", "12.5"], {
      env: connect(fake),
    });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.stdout.split("\n")[0], `${RUN_ID} queued`);
    assert.equal(fake.seen.length, 1, "sans --wait, aucune sonde");
    const [post] = fake.seen as [Seen];
    assert.equal(`${post.method} ${post.url}`, "POST /v1/runs");
    assert.equal(post.headers.authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(post.body), {
      repo: "mon-produit",
      title: "Ajouter X",
      request: "Faire X",
      lane: "full",
      priority: 3,
      budgetUsd: 12.5,
    });
  } finally {
    await fake.close();
  }
});

test("cli-run/AC-2 : --wait rend 0 quand le run devient merged, après avoir sondé les états intermédiaires", async () => {
  const fake = await runServer([
    { run: run("queued") },
    { run: run("running", { step: "impl" }) },
    { run: run("merging") },
    { run: run("merged", { prUrl: "https://forge.test/pr/7" }) },
  ]);
  try {
    const out = await cli([...RUN_ARGS, "--wait", "--poll", "20ms"], { env: connect(fake) });
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, new RegExp(`^${RUN_ID} merged\\n  PR : https://forge.test/pr/7\\n$`));
    assert.deepEqual(
      fake.seen.map((entry) => `${entry.method} ${entry.url}`),
      ["POST /v1/runs", ...Array(4).fill(`GET /v1/runs/${RUN_ID}`)],
    );
  } finally {
    await fake.close();
  }
});

test("cli-run/AC-3 : --wait rend 1 quand le run échoue ou est annulé, et dit la raison", async () => {
  for (const state of ["failed", "cancelled"]) {
    const fake = await runServer([{ run: run("running") }, { run: run(state, { reason: "suite rouge" }) }]);
    try {
      const out = await cli([...RUN_ARGS, "--wait", "--poll", "20ms"], { env: connect(fake) });
      assert.equal(out.code, 1, `${state} : ${out.stderr}`);
      assert.match(out.stdout, new RegExp(`^${RUN_ID} ${state}`));
      assert.match(out.stderr, /suite rouge/);
    } finally {
      await fake.close();
    }
  }
});

test("cli-run/AC-4 : --wait rend 3 quand le run attend un humain, avec la raison et les questions ouvertes", async () => {
  const waits = [
    {
      view: { run: run("awaiting_human", { step: "specs", reason: "specs à valider avant /impl : découpage" }) },
      kind: "specs",
      says: /specs à valider avant \/impl : découpage/,
    },
    {
      view: { run: run("awaiting_human", { reason: "validation humaine : preuves partielles" }) },
      kind: "verdict",
      says: /validation humaine : preuves partielles/,
    },
    {
      view: { run: run("awaiting_human", { step: "review", reason: "budget dépassé : 12 $ sur 10 $" }) },
      kind: "budget",
      says: /budget dépassé/,
    },
    {
      view: {
        run: run("escalated", { reason: "1 décision(s) irréversible(s) à trancher" }),
        escalations: [
          { id: 4, status: "open", question: "Supprimer la table ?", options: ["Oui", "Non"], recommended: "Non" },
          { id: 3, status: "answered", question: "Déjà tranchée ?", options: ["Oui"], recommended: null },
        ],
      },
      kind: "questions",
      says: /Supprimer la table \?/,
      reason: /décision\(s\) irréversible\(s\)/,
    },
  ];
  for (const { view, kind, says, reason = says } of waits) {
    const fake = await runServer([view]);
    try {
      const text = await cli([...RUN_ARGS, "--wait", "--poll", "20ms"], { env: connect(fake) });
      assert.equal(text.code, 3, `${kind} : ${text.stderr}`);
      assert.match(text.stderr, says);
      assert.doesNotMatch(text.stderr, /Déjà tranchée/);
      const json = only(await cli([...RUN_ARGS, "--wait", "--poll", "20ms", "--json"], { env: connect(fake) }));
      assert.equal(json.exitCode, 3);
      assert.equal(json.ok, false);
      const waiting = json.waiting as { kind: string; reason: string; questions?: { id: number }[] };
      assert.equal(waiting.kind, kind);
      assert.match(waiting.reason, reason);
      assert.deepEqual(
        waiting.questions?.map((question) => question.id),
        kind === "questions" ? [4] : undefined,
      );
    } finally {
      await fake.close();
    }
  }
});

test("cli-run/AC-5 : --wait rend 4 au délai, sans rien annuler : le run continue sur le serveur", async () => {
  const fake = await runServer([{ run: run("running", { step: "impl" }) }]);
  try {
    const out = await cli([...RUN_ARGS, "--wait", "--timeout", "300ms", "--poll", "50ms", "--json"], {
      env: connect(fake),
    });
    assert.equal(out.code, 4);
    const json = only(out);
    assert.equal(json.ok, false);
    assert.equal(json.exitCode, 4);
    assert.equal(json.runId, RUN_ID);
    assert.equal(json.state, "running");
    assert.deepEqual([...new Set(fake.seen.map((entry) => entry.method))], ["POST", "GET"]);
  } finally {
    await fake.close();
  }
});

test("cli-run/AC-6 : serveur muet, jamais joint ou non configuré : 5", async () => {
  const closed = await runServer([{ run: run("merged") }]);
  const url = closed.url;
  await closed.close();
  const mute = await cli(RUN_ARGS, { env: { HARNESS_URL: url, HARNESS_TOKEN: TOKEN } });
  assert.equal(mute.code, 5);
  assert.match(mute.stderr, /injoignable/);
  const unconfigured = await cli(["status", RUN_ID]);
  assert.equal(unconfigured.code, 5);
  assert.match(unconfigured.stderr, /HARNESS_URL/);
  const gateway = await serve(() => ({ status: 503, body: { error: "redémarrage" } }));
  try {
    const out = await cli(["status", RUN_ID], { env: connect(gateway) });
    assert.equal(out.code, 5, "un 503 qui dure est un serveur injoignable, pas un refus");
    assert.equal(gateway.seen.length, 2, "une relance, pas plus");
  } finally {
    await gateway.close();
  }
});

test("cli-run/AC-7 : une ligne de commande fausse rend 2 sans toucher au serveur", async () => {
  const fake = await runServer([{ run: run("merged") }]);
  try {
    const wrong = [
      [...RUN_ARGS, "--inconnue"],
      [...RUN_ARGS, "--token", TOKEN],
      ["run", "--title", "T", "--request", "R"],
      ["run", "--repo", "r", "--title", "T"],
      [...RUN_ARGS, "--lane", "rapide"],
      [...RUN_ARGS, "--wait", "--timeout", "bientôt"],
      [...RUN_ARGS, "--timeout", "5m"],
      [...RUN_ARGS, "--budget", "-3"],
      [...RUN_ARGS, "--priority", "x"],
      [...RUN_ARGS, "--key", "deux mots"],
      ["status"],
      ["wait", "a", "b"],
      ["danser"],
      [],
    ];
    for (const args of wrong) {
      const out = await cli(args, { env: connect(fake) });
      assert.equal(out.code, 2, `${args.join(" ")} : ${out.stderr}`);
      assert.equal(out.stdout, "");
    }
    const unknown = await cli([...RUN_ARGS, "--inconnue"], { env: connect(fake) });
    assert.match(unknown.stderr, /option inconnue .*--inconnue/);
    assert.equal(fake.seen.length, 0);
  } finally {
    await fake.close();
  }
});

test("cli-run/AC-8 : le jeton n'apparaît dans aucune sortie, même quand le serveur le répète", async () => {
  const echo = await serve(() => ({ status: 400, body: { error: `jeton ${TOKEN} refusé` } }));
  const merged = await runServer([{ run: run("failed", { reason: `échec avec ${TOKEN}` }) }]);
  try {
    const outputs = [
      await cli(RUN_ARGS, { env: connect(echo) }),
      await cli([...RUN_ARGS, "--json"], { env: connect(echo) }),
      await cli([...RUN_ARGS, "--wait", "--poll", "20ms"], { env: connect(merged) }),
      await cli([...RUN_ARGS, "--wait", "--poll", "20ms", "--json"], { env: connect(merged) }),
      await cli(["list"], { env: connect(merged) }),
      await cli([...RUN_ARGS, "--jeton", TOKEN], { env: connect(merged) }),
    ];
    assert.deepEqual(
      outputs.map((out) => out.code),
      [1, 1, 1, 1, 0, 2],
    );
    for (const out of outputs) {
      assert.doesNotMatch(out.stdout + out.stderr, new RegExp(TOKEN), `${out.stdout}${out.stderr}`);
    }
    assert.match(outputs[0]!.stderr, /refusé par le serveur \(400\)/);
  } finally {
    await echo.close();
    await merged.close();
  }
});

test("cli-run/AC-9 : la même --key porte la même Idempotency-Key ; sans --key, une clé est tirée et gardée à la relance", async () => {
  const fake = await runServer([{ run: run("merged") }]);
  try {
    for (let time = 0; time < 2; time += 1) {
      const out = await cli([...RUN_ARGS, "--key", "livraison-42"], { env: connect(fake) });
      assert.equal(out.code, 0, out.stderr);
    }
    assert.deepEqual(
      fake.seen.map((entry) => entry.headers["idempotency-key"]),
      ["livraison-42", "livraison-42"],
    );
  } finally {
    await fake.close();
  }
  // Sans --key : une clé aléatoire, la même à la relance après un 503 ; jamais de relance sur un 4xx.
  const flaky = await serve((_seen, index) =>
    index === 0 ? { status: 503, body: { error: "redémarrage" } } : { status: 201, body: { run: run("queued") } },
  );
  const refused = await serve(() => ({ status: 409, body: { error: "clé déjà prise" } }));
  try {
    const out = await cli(RUN_ARGS, { env: connect(flaky) });
    assert.equal(out.code, 0, out.stderr);
    const keys = flaky.seen.map((entry) => entry.headers["idempotency-key"]);
    assert.equal(keys.length, 2);
    assert.match(String(keys[0]), /^[\x21-\x7e]{8,}$/);
    assert.equal(keys[0], keys[1]);
    const other = await cli(RUN_ARGS, { env: connect(flaky) });
    assert.equal(other.code, 0);
    assert.notEqual(flaky.seen[2]?.headers["idempotency-key"], keys[0], "chaque lancement tire sa propre clé");
    const no = await cli(RUN_ARGS, { env: connect(refused) });
    assert.equal(no.code, 1);
    assert.equal(refused.seen.length, 1, "un 4xx n'est jamais relancé");
  } finally {
    await flaky.close();
    await refused.close();
  }
});

test("cli-run/AC-10 : --json rend UN objet sur stdout, y compris pour un échec, une option fausse ou un serveur muet", async () => {
  const fake = await runServer([{ run: run("merged", { mergeSha: "abc" }) }]);
  try {
    const created = only(await cli([...RUN_ARGS, "--json"], { env: connect(fake) }));
    assert.equal(created.ok, true);
    assert.equal(created.exitCode, 0);
    assert.equal(created.runId, RUN_ID);
    const done = only(await cli([...RUN_ARGS, "--wait", "--poll", "20ms", "--json"], { env: connect(fake) }));
    assert.equal(done.ok, true);
    assert.equal(done.state, "merged");
    assert.equal(done.outcome, "delivered");
    const unknown = only(await cli([...RUN_ARGS, "--inconnue", "--json"], { env: connect(fake) }));
    assert.equal(unknown.ok, false);
    assert.equal(unknown.exitCode, 2);
    assert.match(String(unknown.error), /--inconnue/);
    const missing = only(
      await cli(["status", "inconnu", "--json"], { env: { ...connect(fake), HARNESS_URL: "http://127.0.0.1:1" } }),
    );
    assert.equal(missing.ok, false);
    assert.equal(missing.exitCode, 5);
    assert.equal(typeof missing.error, "string");
  } finally {
    await fake.close();
  }
  const refusing = await serve(() => ({ status: 404, body: { error: "run inconnu" } }));
  try {
    const out = await cli(["status", "inconnu", "--json"], { env: connect(refusing) });
    assert.equal(out.code, 1);
    const json = only(out);
    assert.equal(json.ok, false);
    assert.match(String(json.error), /run inconnu/);
  } finally {
    await refusing.close();
  }
});

test("cli-run/AC-11 : --request - lit la demande sur stdin, bornée à ce que le serveur accepte", async () => {
  const fake = await runServer([{ run: run("merged") }]);
  try {
    const request = "Ligne un\nLigne « deux » avec des accents\n";
    const out = await cli(["run", "--repo", "mon-produit", "--title", "T", "--request", "-"], {
      env: connect(fake),
      stdin: request,
    });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(JSON.parse(fake.seen[0]!.body).request, request);
    const big = await cli(["run", "--repo", "r", "--title", "T", "--request", "-"], {
      env: connect(fake),
      stdin: Buffer.alloc(1024 * 1024 + 1, "a"),
    });
    assert.equal(big.code, 2);
    assert.match(big.stderr, /1 Mio/);
    const blank = await cli(["run", "--repo", "r", "--title", "T", "--request", "-"], {
      env: connect(fake),
      stdin: "  \n",
    });
    assert.equal(blank.code, 2);
    assert.equal(fake.seen.length, 1, "seule la première demande est partie");
  } finally {
    await fake.close();
  }
});

test("cli-run/AC-12 : status, wait et list lisent le serveur, avec la connexion de ~/.omp/harness.json à défaut d'environnement", async () => {
  const fake = await serve((seen) =>
    seen.url === "/v1/runs" || seen.url.startsWith("/v1/runs?")
      ? { status: 200, body: { runs: [run("running"), { ...run("merged"), id: "rdef456", title: "Autre" }] } }
      : { status: 200, body: { run: run("awaiting_human", { reason: "validation humaine" }), escalations: [] } },
  );
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cli-run-home-"));
  fs.mkdirSync(path.join(home, ".omp"));
  fs.writeFileSync(path.join(home, ".omp", "harness.json"), JSON.stringify({ url: `${fake.url}/`, token: TOKEN }));
  try {
    const env = { HOME: home };
    const status = await cli(["status", RUN_ID], { env });
    assert.equal(status.code, 3);
    assert.match(status.stdout, new RegExp(`^${RUN_ID} awaiting_human\\n  raison : validation humaine`));
    const waited = await cli(["wait", RUN_ID, "--timeout", "2s"], { env });
    assert.equal(waited.code, 3);
    const list = await cli(["list", "--repo", "mon produit"], { env });
    assert.equal(list.code, 0, list.stderr);
    assert.deepEqual(list.stdout.split("\n").filter(Boolean), [
      `${RUN_ID} running mon-produit Ajouter X`,
      "rdef456 merged mon-produit Autre",
    ]);
    assert.equal(fake.seen.at(-1)?.url, "/v1/runs?repo=mon%20produit");
    assert.equal(fake.seen.at(-1)?.headers.authorization, `Bearer ${TOKEN}`);
    const json = only(await cli(["list", "--json"], { env }));
    assert.equal((json.runs as unknown[]).length, 2);
    // Un run encore en cours n'est ni livré ni échoué : `status` rend 4, comme un `wait` qui n'attendrait pas.
    const running = await serve(() => ({ status: 200, body: { run: run("running"), escalations: [] } }));
    try {
      const out = await cli(["status", RUN_ID, "--json"], { env: connect(running) });
      assert.equal(out.code, 4);
      assert.equal(only(out).outcome, "running");
    } finally {
      await running.close();
    }
  } finally {
    await fake.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
