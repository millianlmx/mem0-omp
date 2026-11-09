// Un faux CLI de moteur de conteneurs pour les tests de la QA de /review (browser/qa.ts).
//
// Ce module n'est pas un fichier de test : `qa-doubles.ts` le lance comme process enfant, à la place de
// `docker`, avec le dossier d'état en premier argument (`node fake-docker.ts <état> <args docker…>`).
// Il ne lance AUCUN vrai conteneur :
// - `run` d'un job heavy (sans `-d`) exécute la commande ICI, dans son `--workdir`, avec ses `--env` ;
// - `run -d` de la prévisualisation (image des tests) crée un « conteneur » d'état ;
// - `run -d` du navigateur de QA (image `omp-harness-obscura:local`) lance un VRAI `obscura serve` (le
//   binaire épinglé, `control.obscuraBin`) dont le réseau est modélisé par `--proxy` : il n'atteint que le
//   serveur de test de SA prévisualisation (`control.netns[<prévisualisation>]`, sinon `control.defaultNetns`),
//   tout autre hôte reçoit 404 de ce serveur ; le jeton vient de l'environnement du CLI (`--env OBSCURA_CDP_TOKEN`) ;
// - `exec <navigateur> /busybox nc 127.0.0.1 9222` relie stdin/stdout à ce vrai Obscura ;
// - `exec <navigateur> /busybox wget …` sonde le serveur de la prévisualisation ;
// - `inspect`, `logs`, `rm` répondent d'après l'état ; chaque appel est journalisé.
// `control.json` (écrit par le test) pilote les pannes : `failRun` (`preview` | `browser`), `neverReady`, `previewExited`,
// `previewLogs`.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";

const [stateDir, ...argv] = process.argv.slice(2) as [string, ...string[]];

type Control = {
  obscuraBin?: string;
  netns?: Record<string, number>;
  defaultNetns?: number;
  failRun?: "preview" | "browser";
  neverReady?: boolean;
  previewExited?: boolean;
  previewLogs?: string;
};

const control = (): Control => {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir, "control.json"), "utf8")) as Control;
  } catch {
    return {};
  }
};

const stateFile = (name: string): string => path.join(stateDir, `${name}.json`);

fs.appendFileSync(
  path.join(stateDir, "log.jsonl"),
  `${JSON.stringify({ argv, tokenEnv: process.env.OBSCURA_CDP_TOKEN ?? null })}\n`,
);

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

type Container = {
  role: "preview" | "browser";
  network: string | null;
  /** Navigateur : le process Obscura et son port d'écoute réel. */
  pid?: number;
  port?: number;
  preview?: string;
};

const read = (name: string): Container | null => {
  try {
    return JSON.parse(fs.readFileSync(stateFile(name), "utf8")) as Container;
  } catch {
    return null;
  }
};

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function run(args: string[]): Promise<void> {
  let name = "";
  let network: string | null = null;
  let detached = false;
  let label = "";
  let workdir = ".";
  const env: Record<string, string> = {};
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "-d") detached = true;
    else if (arg === "--env") {
      const entry = args[++i] as string;
      const eq = entry.indexOf("=");
      // `--env NOM` sans valeur : le CLI la lit dans son environnement.
      if (eq === -1) env[entry] = process.env[entry] ?? "";
      else env[entry.slice(0, eq)] = entry.slice(eq + 1);
    } else if (arg === "--volume") i++;
    else if (arg.startsWith("--name=")) name = arg.slice(7);
    else if (arg.startsWith("--network=")) network = arg.slice(10);
    else if (arg.startsWith("--label=")) label = arg.slice(8);
    else if (arg.startsWith("--workdir=")) workdir = arg.slice(10);
    else if (!arg.startsWith("-")) break;
  }
  const image = args[i] as string;
  const rest = args.slice(i + 1);
  if (label === "omp-harness=qa") {
    const role = image === "omp-harness-obscura:local" ? "browser" : "preview";
    if (control().failRun === role) fail("faux moteur : démarrage refusé", 125);
    if (!detached) fail("faux moteur : la QA part en -d", 2);
    if (role === "preview") {
      fs.writeFileSync(stateFile(name), JSON.stringify({ role, network } satisfies Container));
      process.stdout.write(`${name}\n`);
      return;
    }
    const preview = network?.startsWith("container:") ? network.slice(10) : "";
    if (read(preview)?.role !== "preview") fail(`faux moteur : No such container: ${preview}`, 125);
    // Sans binaire (`obscuraBin` absent) : un navigateur « inerte », que les tests de panne n'ont pas besoin de joindre.
    if (control().obscuraBin === undefined) {
      fs.writeFileSync(stateFile(name), JSON.stringify({ role, network, preview } satisfies Container));
      process.stdout.write(`${name}\n`);
      return;
    }
    const proxyPort = control().netns?.[preview] ?? control().defaultNetns;
    if (proxyPort === undefined) fail("faux moteur : aucun serveur pour cette prévisualisation", 125);
    const token = env.OBSCURA_CDP_TOKEN ?? "";
    const port = await freePort();
    const child = spawn(
      control().obscuraBin as string,
      ["serve", "--host", "127.0.0.1", "--port", String(port), ...rest, "--proxy", `http://127.0.0.1:${proxyPort}`],
      {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: fs.mkdtempSync(path.join(stateDir, "obscura-home-")),
          OBSCURA_CDP_TOKEN: token,
          // La page n'est pas sur le port d'écoute réel : Obscura doit accepter l'en-tête Host du CDP (127.0.0.1:9222).
          OBSCURA_CDP_FORWARDED_HOST: "127.0.0.1",
          OBSCURA_CDP_FORWARDED_PORT: "9222",
        },
        stdio: "ignore",
        detached: true,
      },
    );
    child.unref();
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        const reply = await fetch(`http://127.0.0.1:${port}/json/version`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (reply.status === 200) break;
      } catch {
        // Pas encore à l'écoute.
      }
      if (Date.now() > deadline) fail("faux moteur : obscura n'est pas prêt en 15 s", 125);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    fs.writeFileSync(
      stateFile(name),
      JSON.stringify({ role, network, pid: child.pid, port, preview } satisfies Container),
    );
    // Le test retrouve ainsi le process Obscura réel même une fois le conteneur retiré.
    fs.appendFileSync(path.join(stateDir, "log.jsonl"), `${JSON.stringify({ started: { name, pid: child.pid } })}\n`);
    process.stdout.write(`${name}\n`);
    return;
  }
  // Un job heavy : la commande tourne ici, comme test/support/fake-engine.sh.
  const [command, ...commandArgs] = rest as [string, ...string[]];
  const result = spawnSync(command, commandArgs, {
    cwd: workdir,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

async function exec(args: string[]): Promise<void> {
  const rest = args.filter((arg) => arg !== "-i");
  const [name, command, applet, ...more] = rest as [string, string, string, ...string[]];
  const container = read(name);
  if (container === null) fail(`Error response from daemon: No such container: ${name}`);
  if (container?.role !== "browser" || command !== "/busybox") fail("faux moteur : exec inconnu", 126);
  const netns = control();
  if (applet === "wget") {
    if (netns.neverReady) process.exit(1);
    const url = new URL(more[more.length - 1] as string);
    const port = netns.netns?.[container.preview as string] ?? netns.defaultNetns;
    // Comme un proxy : la requête part en forme absolue, le serveur de test choisit sa page par l'hôte visé.
    const status = await new Promise<number>((resolve) => {
      const request = http.request(
        { host: "127.0.0.1", port, path: String(url), headers: { host: url.host } },
        (reply) => {
          reply.resume();
          resolve(reply.statusCode ?? 0);
        },
      );
      request.on("error", () => resolve(0));
      request.end();
    });
    process.exit(status >= 200 && status < 300 ? 0 : 1);
  }
  if (applet === "nc") {
    const socket = net.connect(container.port as number, "127.0.0.1");
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
    socket.on("close", () => process.exit(0));
    socket.on("error", () => process.exit(1));
    return;
  }
  fail(`faux moteur : applet inconnu ${applet}`, 126);
}

function rm(args: string[]): void {
  let missing = false;
  for (const name of args.filter((arg) => !arg.startsWith("-"))) {
    const container = read(name);
    if (container === null) {
      if (name.startsWith("omp-qa-")) missing = true;
      continue;
    }
    if (container.pid !== undefined) {
      try {
        process.kill(container.pid, "SIGKILL");
      } catch {
        // Déjà parti.
      }
    }
    fs.rmSync(stateFile(name), { force: true });
  }
  if (missing) fail("Error response from daemon: No such container", 1);
}

switch (argv[0]) {
  case "run":
    await run(argv.slice(1));
    break;
  case "exec":
    await exec(argv.slice(1));
    break;
  case "inspect": {
    const name = argv[argv.length - 1] as string;
    if (read(name) === null || control().previewExited) fail(`Error: No such object: ${name}`);
    process.stdout.write("true\n");
    break;
  }
  case "logs":
    process.stdout.write(control().previewLogs ?? "");
    break;
  case "rm":
    rm(argv.slice(1));
    break;
  case "version":
  case "image":
    break;
  default:
    fail(`faux moteur : commande inconnue ${argv[0]}`, 2);
}
