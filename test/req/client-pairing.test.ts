// Feature client-pairing : `harness.sh pair` donne un code `omp1:…` qui porte le
// harness, son jeton, la mémoire partagée et son jeton. `/pair <code>` dans omp le
// vérifie auprès du serveur puis l'écrit là où le lisent le plugin, le plugin mémoire
// et l'app (`~/.omp/harness.json`, `~/.omp/mem0.json`) : une saisie relie tout.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import reqExtension from "../../omp-mem0-req/extension.ts";
import { decodePairing, encodePairing, writePairing } from "../../omp-mem0-req/harness.ts";
import { fakeSchema } from "../support/fake-zod.ts";
import { tmpdir } from "../support/repo.ts";

const SCRIPT = path.join(import.meta.dirname, "..", "..", "omp-harness", "deploy", "container", "harness.sh");
const TOKEN = "t".repeat(64);
const SAMPLE = {
  url: "https://vps.tailnet.ts.net",
  token: TOKEN,
  mem0Url: "https://vps.tailnet.ts.net:8443",
  mem0Token: "m".repeat(64),
};

test("client-pairing/AC-1 : un code se décode à l'identique ; un texte qui n'en est pas un est refusé", () => {
  assert.deepEqual(decodePairing(` ${encodePairing(SAMPLE)}\n`), SAMPLE);
  assert.deepEqual(decodePairing(encodePairing({ ...SAMPLE, mem0Url: "", mem0Token: "" })), {
    ...SAMPLE,
    mem0Url: "",
    mem0Token: "",
  });
  for (const bad of [
    "",
    TOKEN,
    `omp2:${encodePairing(SAMPLE).slice(5)}`,
    encodePairing({ ...SAMPLE, url: "vps:8790" }),
    encodePairing({ ...SAMPLE, token: "" }),
    encodePairing({ ...SAMPLE, mem0Url: "ftp://vps" }),
  ])
    assert.equal(decodePairing(bad), null, bad);
});

test("client-pairing/AC-2 : le code qu'affiche `harness.sh pair` est celui que lit le plugin", () => {
  const root = tmpdir("client-pairing-root-");
  const secrets = tmpdir("client-pairing-secrets-");
  fs.mkdirSync(path.join(root, "state"));
  fs.writeFileSync(path.join(root, "state", "token"), `${SAMPLE.token}\n`);
  fs.writeFileSync(path.join(root, "published.env"), `URL=${SAMPLE.url}\nMEM0_URL=${SAMPLE.mem0Url}\n`);
  fs.writeFileSync(path.join(secrets, "mem0.env"), `MEM0_HTTP_TOKEN=${SAMPLE.mem0Token}\nOMLX_EMBED_MODEL=bge-m3\n`);
  const run = spawnSync("bash", [SCRIPT, "pair"], {
    encoding: "utf8",
    env: { ...process.env, OMP_HARNESS_ENGINE: "sh", OMP_HARNESS_ROOT: root, OMP_HARNESS_SECRETS: secrets },
  });
  assert.equal(run.status, 0, run.stderr);
  const code = /^\s+(omp1:\S+)$/m.exec(run.stdout)?.[1] ?? "";
  assert.deepEqual(decodePairing(code), SAMPLE);
});

function pairCommand() {
  let handler: ((args: unknown, ctx: unknown) => Promise<void>) | undefined;
  const pi = {
    zod: { z: fakeSchema() },
    registerCommand: (name: string, spec: { handler: typeof handler }) => {
      if (name === "pair") handler = spec.handler;
    },
    registerTool: () => {},
    sendUserMessage: () => {},
  };
  reqExtension(pi as never);
  const notes: string[] = [];
  const ctx = {
    cwd: "/",
    hasUI: true,
    ui: { notify: (message: string, level = "info") => notes.push(`${level}: ${message}`) },
  };
  return { run: (code: string) => (handler as NonNullable<typeof handler>)(code, ctx), notes };
}

test("client-pairing/AC-3 : /pair vérifie le jeton auprès du serveur, puis écrit les deux réglages en gardant les dépôts déjà reliés", async () => {
  const server = http.createServer((req, res) => {
    const ok = req.url === "/v1/inbox" && req.headers.authorization === `Bearer ${TOKEN}`;
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify(ok ? { runs: [], audits: [], escalations: [] } : { error: "jeton refusé" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const home = tmpdir("client-pairing-home-");
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    fs.mkdirSync(path.join(home, ".omp"));
    fs.writeFileSync(
      path.join(home, ".omp", "harness.json"),
      JSON.stringify({ url: "http://ancien", token: "x", repos: { "/code/produit": "produit" } }),
    );
    const { run, notes } = pairCommand();

    await run("pas un code");
    await run(encodePairing({ ...SAMPLE, url, token: "mauvais" }));
    assert.match(notes[0] ?? "", /^error: \[pair\] code illisible/);
    assert.match(notes[1] ?? "", /^error: .*Rien n'a été écrit/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, ".omp", "harness.json"), "utf8")).url, "http://ancien");

    await run(encodePairing({ ...SAMPLE, url }));
    assert.match(notes[2] ?? "", /^info: \[pair\] relié à http:\/\/127\.0\.0\.1:\d+ \(0 feature/);
    const harness = JSON.parse(fs.readFileSync(path.join(home, ".omp", "harness.json"), "utf8"));
    assert.deepEqual(harness, { url, token: TOKEN, repos: { "/code/produit": "produit" } });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, ".omp", "mem0.json"), "utf8")), {
      url: SAMPLE.mem0Url,
      token: SAMPLE.mem0Token,
    });
    for (const file of ["harness.json", "mem0.json"])
      assert.equal(fs.statSync(path.join(home, ".omp", file)).mode & 0o777, 0o600);
  } finally {
    process.env.HOME = previousHome;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("client-pairing/AC-4 : un code sans mémoire ne touche pas au réglage mémoire existant", () => {
  const home = tmpdir("client-pairing-nomem-");
  fs.mkdirSync(path.join(home, ".omp"));
  fs.writeFileSync(path.join(home, ".omp", "mem0.json"), '{"url":"http://127.0.0.1:8321"}\n');
  assert.deepEqual(writePairing({ ...SAMPLE, mem0Url: "", mem0Token: "" }, home), [
    path.join(home, ".omp", "harness.json"),
  ]);
  assert.equal(fs.readFileSync(path.join(home, ".omp", "mem0.json"), "utf8"), '{"url":"http://127.0.0.1:8321"}\n');
});
