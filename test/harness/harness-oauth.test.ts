// Feature harness-oauth : les abonnements (Claude Pro/Max, ChatGPT, Gemini…) connectés
// depuis les apps Mac et iOS. omp mène la connexion chez les runners — `get_login_providers`
// et `login` en mode RPC — et le service relaie à l'app le lien à ouvrir puis le code
// qu'elle rapporte. Ici, les runners sont le faux omp (test/support/fake-omp-rpc.ts),
// dont le flux de connexion suit ce que l'omp épinglé fait vraiment.
import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { createHandler } from "../../omp-harness/http.ts";
import { loginArgv } from "../../omp-harness/oauth.ts";
import { RpcRunner } from "../../omp-harness/rpc.ts";
import type { RunnerProcess } from "../../omp-harness/rpc.ts";
import { fakeWorld, harnessRepo, testConfig, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

const ADMIN = "a".repeat(64);
const PROVIDERS = [
  { id: "openai-codex", name: "ChatGPT Plus/Pro (Codex Subscription)", available: true, authenticated: false },
  { id: "anthropic", name: "Anthropic (Claude Pro/Max)", available: true, authenticated: true },
];
const FLOW = {
  url: "https://auth.example.com/oauth/authorize?state=s1",
  instructions:
    "Complete login in your browser. If the browser cannot reach this machine, paste the final redirect URL.",
  prompt: "Paste the authorization code (or full redirect URL):",
  code: "code-4242",
};

type Served = { url: string; operator: string; close: () => Promise<void> };

async function serve(world: FakeWorld): Promise<Served> {
  const clients = new ClientRegistry(path.join(tmpdir("harness-oauth-"), "clients.json"), ADMIN);
  const { token: operator } = clients.add("iphone", "operator", "*");
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    operator,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function call(url: string, token: string, method: string, route: string, body?: unknown) {
  const response = await fetch(`${url}${route}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await response.text();
  return { status: response.status, body: JSON.parse(raw) as Record<string, unknown> };
}

type Login = { id: string; state: string; url: string | null; prompt: string | null; error: string | null };

/** Une connexion lue jusqu'à ce que `ready` dise oui. */
async function until(served: Served, id: string, ready: (login: Login) => boolean): Promise<Login> {
  const start = Date.now();
  for (;;) {
    const login = (await call(served.url, ADMIN, "GET", `/v1/oauth/logins/${id}`)).body.login as Login;
    if (ready(login)) return login;
    if (Date.now() - start > 10_000) throw new Error(`délai dépassé : ${JSON.stringify(login)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function withWorld(scenario: Record<string, unknown>, body: (world: FakeWorld, served: Served) => Promise<void>) {
  const world = fakeWorld({ loginProviders: PROVIDERS, ...scenario });
  const served = await serve(world);
  try {
    await body(world, served);
  } finally {
    await served.close();
    await world.orchestrator.stop();
  }
}

test("harness-oauth/AC-1 : les fournisseurs qu'omp sait connecter, et leur état chez les runners, pour un admin seulement", async () => {
  await withWorld({}, async (world, served) => {
    const listed = await call(served.url, ADMIN, "GET", "/v1/oauth");
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(listed.body.providers, PROVIDERS);
    assert.equal(listed.body.login, null, "aucune connexion en cours");
    assert.equal((await call(served.url, served.operator, "GET", "/v1/oauth")).status, 403);
    // Le même omp que les runners : mode RPC, profil des runners, sans session.
    const argv = world.spawned.at(-1)?.args ?? [];
    for (const flag of ["--mode", "rpc", "--no-session", "--profile", world.config.runner.profile])
      assert.ok(argv.includes(flag), `${flag} absent`);
    const health = await (await fetch(`${served.url}/v1/health`)).json();
    assert.ok((health as { features: string[] }).features.includes("providers-oauth"));
  });
});

test("harness-oauth/AC-2 : une connexion relaie le lien et la question d'omp, transmet le code, et déclare l'abonnement pour les chaînes", async () => {
  await withWorld({ login: FLOW }, async (world, served) => {
    const started = await call(served.url, ADMIN, "POST", "/v1/oauth/openai-codex/login");
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const id = (started.body.login as Login).id;

    const waiting = await until(served, id, (login) => login.prompt !== null);
    assert.equal(waiting.state, "waiting");
    assert.equal(waiting.url, FLOW.url);
    assert.equal((waiting as unknown as { instructions: string }).instructions, FLOW.instructions);
    assert.equal(waiting.prompt, FLOW.prompt);
    assert.deepEqual((waiting as unknown as { progress: string[] }).progress, [
      "Waiting for browser authentication...",
    ]);
    assert.equal(
      ((await call(served.url, ADMIN, "GET", "/v1/oauth")).body.login as Login).id,
      id,
      "la connexion en cours",
    );

    const answered = await call(served.url, ADMIN, "POST", `/v1/oauth/logins/${id}/answer`, {
      value: ` ${FLOW.code} `,
    });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    assert.equal((answered.body.login as Login).state, "verifying");
    const done = await until(served, id, (login) => login.state === "done");
    assert.equal(done.error, null);
    assert.ok(
      world.log().some((entry) => entry.kind === "ui_response" && entry.value === FLOW.code),
      "le code arrive à omp, sans les espaces copiés autour",
    );

    // L'abonnement figure parmi les fournisseurs, sans clé, et une chaîne peut le nommer.
    const catalog = (await call(served.url, ADMIN, "GET", "/v1/providers")).body;
    const codex = (catalog.providers as Record<string, unknown>[]).find((p) => p.name === "openai-codex");
    assert.equal(codex?.kind, "oauth");
    assert.equal(codex?.hasKey, false);
    assert.ok((catalog.kinds as string[]).includes("oauth"));
    const chains = await call(served.url, ADMIN, "PUT", "/v1/models", {
      models: { fast: [], standard: [{ provider: "openai-codex", model: "gpt-5.2-codex" }], heavy: [] },
    });
    assert.equal(chains.status, 200, JSON.stringify(chains.body));
    assert.ok(world.log().some((entry) => entry.kind === "command" && entry.providerId === "openai-codex"));
  });
});

test("harness-oauth/AC-3 : Claude Pro/Max se connecte sous `anthropic`, qui garde sa sorte ; omp s'arrête à la fin de chaque connexion", async () => {
  await withWorld({ login: FLOW }, async (world, served) => {
    const id = ((await call(served.url, ADMIN, "POST", "/v1/oauth/anthropic/login")).body.login as Login).id;
    await until(served, id, (login) => login.prompt !== null);
    await call(served.url, ADMIN, "POST", `/v1/oauth/logins/${id}/answer`, { value: FLOW.code });
    await until(served, id, (login) => login.state === "done");
    const providers = (await call(served.url, ADMIN, "GET", "/v1/providers")).body.providers as Record<
      string,
      unknown
    >[];
    assert.equal(
      providers.filter((p) => p.kind === "oauth").length,
      0,
      "un fournisseur connu d'omp n'est pas redéclaré",
    );
    assert.ok(!providers.some((p) => p.name === "anthropic" && p.source === "api"));
    // Le process de la connexion est parti : une nouvelle connexion peut commencer.
    const next = await call(served.url, ADMIN, "POST", "/v1/oauth/openai-codex/login");
    assert.equal(next.status, 201, JSON.stringify(next.body));
    void world;
  });
});

test("harness-oauth/AC-4 : un mauvais code, un refus d'omp ou une annulation finissent la connexion sans rien déclarer ; une seule à la fois", async () => {
  await withWorld({ login: FLOW }, async (_world, served) => {
    const first = ((await call(served.url, ADMIN, "POST", "/v1/oauth/openai-codex/login")).body.login as Login).id;
    const busy = await call(served.url, ADMIN, "POST", "/v1/oauth/anthropic/login");
    assert.equal(busy.status, 409);
    assert.match(String(busy.body.error), /déjà en cours \(openai-codex\)/);
    await until(served, first, (login) => login.prompt !== null);
    await call(served.url, ADMIN, "POST", `/v1/oauth/logins/${first}/answer`, { value: "faux" });
    const failed = await until(served, first, (login) => login.state === "failed");
    assert.equal(failed.error, "Invalid authorization code");
    const again = await call(served.url, ADMIN, "POST", `/v1/oauth/logins/${first}/answer`, { value: FLOW.code });
    assert.equal(again.status, 409, "une connexion finie n'attend plus de code");

    const second = ((await call(served.url, ADMIN, "POST", "/v1/oauth/openai-codex/login")).body.login as Login).id;
    await until(served, second, (login) => login.prompt !== null);
    const cancelled = await call(served.url, ADMIN, "DELETE", `/v1/oauth/logins/${second}`);
    assert.equal((cancelled.body.login as Login).state, "cancelled");
    const providers = (await call(served.url, ADMIN, "GET", "/v1/providers")).body.providers as Record<
      string,
      unknown
    >[];
    assert.equal(providers.filter((p) => p.kind === "oauth").length, 0);
    assert.equal((await call(served.url, ADMIN, "GET", "/v1/oauth/logins/inconnue")).status, 404);
    assert.equal((await call(served.url, ADMIN, "POST", "/v1/oauth/Pas%20Un%20Nom/login")).status, 404);
  });
  await withWorld(
    {
      login: {
        error:
          "Provider 'github-copilot' requires interactive prompts which are not supported in RPC mode. Use the terminal UI to log in.",
      },
    },
    async (_world, served) => {
      const id = ((await call(served.url, ADMIN, "POST", "/v1/oauth/github-copilot/login")).body.login as Login).id;
      const failed = await until(served, id, (login) => login.state === "failed");
      assert.match(String(failed.error), /requires interactive prompts/, "le message d'omp, sans préfixe");
    },
  );
});

test("harness-oauth/AC-5 : l'omp de la connexion est celui des runners — en conteneur, il ne monte que leur HOME ; en systemd, la connexion se fait au terminal", () => {
  const config = testConfig(harnessRepo(), (c) => {
    c.runner.isolation = "container";
    c.container.network = "omp-harness";
    c.container.runnerHome = "/srv/omp/runner-home";
    c.container.runnerEnvFile = "/srv/secrets/runner.env";
    c.container.user = "1000:1000";
    c.ompBin = "/usr/local/bin/omp";
  });
  const line = loginArgv(config, "omp-login-1");
  assert.equal(line.command, "docker");
  const image = line.args.indexOf(config.container.runnerImage);
  const flags = line.args.slice(0, image);
  for (const flag of [
    "run",
    "--rm",
    "-i",
    "--init",
    "--name=omp-login-1",
    "--cap-drop=ALL",
    "--user=1000:1000",
    "--network=omp-harness",
  ])
    assert.ok(flags.includes(flag), `${flag} absent`);
  const volumes = flags.flatMap((arg, i) => (arg === "--volume" ? [flags[i + 1]] : []));
  assert.deepEqual(volumes, ["/srv/omp/runner-home:/home/runner"], "ni worktree, ni clé, ni runner.env");
  assert.deepEqual(line.args.slice(image + 1, image + 4), ["/usr/local/bin/omp", "--mode", "rpc"]);
  assert.ok(line.args.includes(config.runner.profile));

  config.container.runnerHome = null;
  assert.throws(() => loginArgv(config, "omp-login-2"), /runnerHome/);
  config.runner.isolation = "systemd";
  assert.throws(
    () => loginArgv(config, "omp-login-3"),
    (err: Error & { status?: number }) =>
      err.status === 501 && /sudo -u omp-runner -H omp --profile pipeline/.test(err.message),
  );
});

test("harness-oauth/AC-6 : un runner interactif relaie les demandes d'UI qu'un runner d'étape annule", async () => {
  const fake = () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const written: Record<string, unknown>[] = [];
    stdin.on("data", (chunk: Buffer) => {
      for (const line of String(chunk).split("\n").filter(Boolean)) written.push(JSON.parse(line));
    });
    const proc: RunnerProcess = {
      stdin,
      stdout,
      stderr: new PassThrough(),
      kill: () => true,
      once: () => undefined,
      on: () => undefined,
    };
    return { proc, stdout, written };
  };
  const request = `${JSON.stringify({ type: "extension_ui_request", id: "u1", method: "input", title: "Code ?" })}\n`;

  const step = fake();
  const frames: unknown[] = [];
  new RpcRunner(step.proc, { onHostTool: async () => ({ text: "" }), onFrame: (frame) => frames.push(frame) });
  step.stdout.write(request);
  await waitFor(
    () => step.written.length > 0,
    () => "aucune réponse du runner d'étape",
  );
  assert.deepEqual(step.written, [{ type: "extension_ui_response", id: "u1", cancelled: true }]);
  assert.deepEqual(frames, []);

  const login = fake();
  const relayed: Record<string, unknown>[] = [];
  const runner = new RpcRunner(login.proc, {
    onHostTool: async () => ({ text: "" }),
    onFrame: (frame) => relayed.push(frame),
    interactive: true,
  });
  login.stdout.write(request);
  await waitFor(
    () => relayed.length > 0,
    () => "demande d'UI non relayée",
  );
  assert.equal(relayed[0]?.method, "input");
  assert.deepEqual(login.written, [], "rien n'est répondu à la place de l'humain");
  runner.respondUi("u1", "code-1");
  runner.respondUi("u2", null);
  await waitFor(
    () => login.written.length === 2,
    () => JSON.stringify(login.written),
  );
  assert.deepEqual(login.written, [
    { type: "extension_ui_response", id: "u1", value: "code-1" },
    { type: "extension_ui_response", id: "u2", cancelled: true },
  ]);
});

test("harness-oauth/AC-7 : un fournisseur `oauth` se déclare sans adresse ni clé, et refuse une clé", async () => {
  await withWorld({}, async (_world, served) => {
    const declared = await call(served.url, ADMIN, "PUT", "/v1/providers/google-gemini-cli", { kind: "oauth" });
    assert.equal(declared.status, 200, JSON.stringify(declared.body));
    const provider = declared.body.provider as Record<string, unknown>;
    assert.equal(provider.kind, "oauth");
    assert.equal(provider.baseUrl, null);
    assert.deepEqual(provider.models, []);
    const keyed = await call(served.url, ADMIN, "PUT", "/v1/providers/google-gemini-cli", {
      kind: "oauth",
      apiKey: "test-key-12345678",
    });
    assert.equal(keyed.status, 400);
    assert.match(String(keyed.body.error), /pas de clé/);
  });
});
