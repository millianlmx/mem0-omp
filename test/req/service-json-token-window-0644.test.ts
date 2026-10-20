// Tests de service-json-token-window-0644 : `service.json` (qui porte le jeton du
// service) n'existe jamais, même transitoirement, en mode plus ouvert que 0600 ;
// le contrat d'un worktree garde ses permissions ; le propriétaire relit
// toujours le jeton et s'authentifie comme avant.
//
// Ce fichier est LE SEUL porteur des ids `service-json-token-window-0644/AC-<n>`.
// L'instant du `rename` est observé par un espion de `fs.renameSync` (patron de
// blocked-arbitrables.test.ts : remplacement puis `syncBuiltinESMExports()`).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

import {
  SERVICE_VERSION,
  newServiceToken,
  readService,
  serviceFilePath,
  writeBytesAtomic,
  writeService,
} from "../../omp-mem0-req/extension.ts";
import type { ServiceRecord } from "../../omp-mem0-req/extension.ts";
import { SERVICE_TOKEN_HEADER, createServiceRequestHandler } from "../../omp-mem0-req/serviceHttp.ts";
import type { ServiceApi } from "../../omp-mem0-req/serviceApi.ts";

const tmpDirs: string[] = [];

function mktmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  tmpDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function record(stateDir: string, over: Partial<ServiceRecord> = {}): ServiceRecord {
  return {
    version: SERVICE_VERSION,
    pid: process.pid,
    port: 8788,
    token: newServiceToken(),
    startedAt: 1_700_000_000_000,
    stateDir,
    sessionFile: null,
    ...over,
  };
}

/** Le corps sous umask 022, restaurée quoi qu'il arrive. */
function withUmask022<T>(body: () => T): T {
  const previous = process.umask(0o022);
  try {
    return body();
  } finally {
    process.umask(previous);
  }
}

type RenameObservation = {
  from: string;
  to: string;
  tmpMode: number;
  targetExisted: boolean;
  targetModeBefore: number | null;
  targetModeAfter: number;
};

/** `body` exécuté avec un espion de `fs.renameSync` qui relève les modes juste avant et juste après le `rename` réel. */
function observeRenames(body: () => void): RenameObservation[] {
  const seen: RenameObservation[] = [];
  const original = fs.renameSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    const tmpMode = fs.statSync(from).mode & 0o777;
    const targetExisted = fs.existsSync(to);
    const targetModeBefore = targetExisted ? fs.statSync(to).mode & 0o777 : null;
    original(from, to);
    seen.push({
      from: String(from),
      to: String(to),
      tmpMode,
      targetExisted,
      targetModeBefore,
      targetModeAfter: fs.statSync(to).mode & 0o777,
    });
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    body();
  } finally {
    fs.renameSync = original;
    syncBuiltinESMExports();
  }
  return seen;
}

function noTmpLeft(stateDir: string): boolean {
  return !fs.readdirSync(stateDir).some((name) => name.includes(".tmp-"));
}

test("service-json-token-window-0644/AC-1 : sous umask 022, le temporaire est en 0600 au rename et service.json est en 0600 dès qu'il existe (temporaire périmé en 0644 compris)", () => {
  withUmask022(() => {
    for (const staleTmp of [false, true]) {
      const stateDir = mktmp("sjtw-ac1-");
      const file = serviceFilePath(stateDir);
      const tmp = `${file}.tmp-${process.pid}`;
      if (staleTmp) {
        // Le reste d'un crash antérieur : rouvert en place, il garderait 0644.
        fs.writeFileSync(tmp, "périmé", "utf8");
        fs.chmodSync(tmp, 0o644);
      }
      const scenario = staleTmp ? "temporaire périmé" : "dossier neuf";
      const written = record(stateDir);
      const seen = observeRenames(() => writeService(written, stateDir));
      assert.equal(seen.length, 1, `${scenario} : un seul rename`);
      const [obs] = seen;
      assert.equal(obs!.from, tmp);
      assert.equal(obs!.to, file);
      assert.equal(obs!.tmpMode, 0o600, `${scenario} : le temporaire naît en 0600`);
      assert.equal(obs!.targetExisted, false, `${scenario} : service.json n'existe pas avant le rename`);
      assert.equal(obs!.targetModeAfter, 0o600, `${scenario} : service.json est en 0600 dès qu'il existe`);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.deepEqual(readService(stateDir, { alive: () => true }), written);
      assert.equal(noTmpLeft(stateDir), true, `${scenario} : aucun temporaire laissé`);
    }
  });
});

test("service-json-token-window-0644/AC-2 : un service.json préexistant en 0644 est réécrit via un temporaire 0600 et ressort en 0600", () => {
  withUmask022(() => {
    const stateDir = mktmp("sjtw-ac2-");
    const file = serviceFilePath(stateDir);
    fs.writeFileSync(file, `${JSON.stringify(record(stateDir), null, 2)}\n`, "utf8");
    fs.chmodSync(file, 0o644);
    const written = record(stateDir, { port: 9124 });
    const seen = observeRenames(() => writeService(written, stateDir));
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.tmpMode, 0o600, "le temporaire naît en 0600");
    assert.equal(seen[0]!.targetModeBefore, 0o644, "l'ancien fichier était bien en 0644");
    assert.equal(seen[0]!.targetModeAfter, 0o600, "le rename remplace l'inode : le mode du temporaire l'emporte");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readService(stateDir, { alive: () => true }), written);
    assert.equal(noTmpLeft(stateDir), true);
  });
});

test("service-json-token-window-0644/AC-3 : sous umask 022, writeBytesAtomic (contrat d'un worktree) garde 0644", () => {
  withUmask022(() => {
    const stateDir = mktmp("sjtw-ac3-");
    const contract = path.join(stateDir, "contrat.md");
    writeBytesAtomic(contract, new TextEncoder().encode("x\n"));
    assert.equal(fs.statSync(contract).mode & 0o777, 0o644);
    assert.equal(noTmpLeft(stateDir), true);
  });
});

test("service-json-token-window-0644/AC-4 : le propriétaire relit le jeton de service.json et s'authentifie comme avant", async () => {
  const stateDir = mktmp("sjtw-ac4-");
  const written = record(stateDir);
  withUmask022(() => writeService(written));
  const raw = fs.readFileSync(serviceFilePath(stateDir), "utf8");
  assert.equal(raw, `${JSON.stringify(written, null, 2)}\n`, "même format JSON, même chemin");
  const reread = readService(stateDir, { alive: () => true });
  assert.deepEqual(reread, written);

  const handle = createServiceRequestHandler({
    api: { lot: () => null } as unknown as ServiceApi,
    token: written.token,
  });
  const get = (headers: Record<string, string>) =>
    handle(new Request(`http://127.0.0.1/v1/repos/${encodeURIComponent(stateDir)}/lot`, { method: "GET", headers }));
  assert.equal((await get({ [SERVICE_TOKEN_HEADER]: reread!.token })).status, 200, "jeton relu accepté");
  assert.equal((await get({})).status, 401, "sans jeton");
  assert.notEqual(written.token, "0".repeat(32));
  assert.equal((await get({ [SERVICE_TOKEN_HEADER]: "0".repeat(32) })).status, 401, "jeton faux");
});
