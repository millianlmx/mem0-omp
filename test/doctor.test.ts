// Tests de mem0-stack/doctor.sh, le diagnostic de la stack mem0-rs.
//
// Le banc (faux `podman` en tête de PATH, API mem0 jouée par node:http, lancement
// du vrai script) vit dans test/doctor-banc.ts : il sert aussi aux preuves AC-8 et
// AC-9 de test/mem0-stack-bascule-rust.test.ts. Aucun conteneur n'est démarré : ce
// que l'on éprouve ici, ce sont les décisions du script (code de sortie, absence
// nommée, en-tête de token), pas la santé de la machine.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { containerToken, doctorEnv, runDoctor, startApi, writeShim } from "./doctor-banc.ts";

const tmpDirs: string[] = [];
test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  tmpDirs.push(dir);
  return dir;
}

test("doctor/AC-7 : une vérification en échec rend un code de sortie non nul", async () => {
  const shimDir = writeShim(tmpDir("doctor-ac7-"));

  // Aucun conteneur : le diagnostic doit le dire, et surtout ne pas rendre 0.
  const broken = await runDoctor(doctorEnv(shimDir, "absent"));
  assert.notEqual(broken.status, 0, `doctor.sh a rendu 0 sur une stack absente :\n${broken.output}`);

  // Stack saine : conteneurs annoncés par le shim, API mem0 servie par le test.
  const api = await startApi();
  try {
    const healthy = await runDoctor(doctorEnv(shimDir, "healthy", { MEM0_HTTP_URL: api.url }));
    assert.equal(healthy.status, 0, `doctor.sh a rendu ${healthy.status} sur une stack saine :\n${healthy.output}`);
    assert.match(healthy.output, /écriture et relecture fonctionnelles/);
  } finally {
    await api.close();
  }
});

test("doctor/AC-8 : l'absence de conteneur est nommée, sans panne inventée", async () => {
  const shimDir = writeShim(tmpDir("doctor-ac8-"));

  const { status, output } = await runDoctor(doctorEnv(shimDir, "absent"));

  assert.notEqual(status, 0, `doctor.sh a rendu 0 alors qu'il n'y a aucun conteneur :\n${output}`);
  assert.match(output, /absent/, `l'absence du conteneur n'est pas nommée :\n${output}`);
  assert.match(output, /compose up -d/, `le remède compose up -d n'est pas donné :\n${output}`);
  // Plus de sonde Qdrant ni d'appel Python : la pile n'est plus que mem0-rs. Casse
  // respectée : l'en-tête « Ancienne mémoire Python+Qdrant » est légitime.
  assert.doesNotMatch(output, /qdrant:6333|readyz|python/, `vérification de l'ancienne pile :\n${output}`);
});

test("doctor/AC-9 : le token du conteneur est envoyé dans l'aller-retour écriture/relecture", async () => {
  const token = containerToken();
  const api = await startApi({ token });
  try {
    const shimDir = writeShim(tmpDir("doctor-ac9-"));
    const { status, output } = await runDoctor(
      doctorEnv(shimDir, "healthy", { MEM0_HTTP_URL: api.url, SHIM_TOKEN: token }),
    );

    assert.equal(status, 0, `doctor.sh a rendu ${status} avec un token défini dans le conteneur :\n${output}`);
    assert.match(output, /écriture et relecture fonctionnelles/);
    // Le remède de l'embedding ne doit pas apparaître : l'échec, s'il y en avait un,
    // vient d'un 401 et non de la dimension d'embedding.
    assert.doesNotMatch(output, /EMBEDDING_DIMS/);

    // Les DEUX appels de la section 5 ont porté l'en-tête exigé par le serveur :
    // sans lui, le stub aurait répondu 401 et le test serait déjà rouge au-dessus.
    assert.deepEqual(
      api.calls.filter((call) => call.url.startsWith("/memory/")).map((call) => [call.url, call.token]),
      [
        ["/memory/add", token],
        ["/memory/search", token],
      ],
    );
  } finally {
    await api.close();
  }
});

