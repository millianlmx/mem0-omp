// Le poste de travail, ses navigateurs : chaque extension appairée (un profil Chrome,
// « Perso », « ADEO »…) se présente par un `browserId` stable et un libellé. La présence
// (en ligne, long-polls en cours, onglets de l'agent) est en mémoire dans workstation.ts ;
// cette couche garde la liste, le libellé, la version et la dernière vue.
import { WorkstationCaptureStore } from "./workstation-captures.ts";
import { num, str, strOrNull } from "./sql.ts";
import type { Row } from "./sql.ts";

export type WorkstationBrowserRow = {
  id: string;
  label: string | null;
  version: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
};

function browserOf(row: Row): WorkstationBrowserRow {
  return {
    id: str(row, "id"),
    label: strOrNull(row, "label"),
    version: strOrNull(row, "version"),
    firstSeenAt: num(row, "first_seen_at"),
    lastSeenAt: num(row, "last_seen_at"),
  };
}

export class WorkstationBrowserStore extends WorkstationCaptureStore {
  /** Un contact du navigateur `id` : créé à la première vue ; libellé et version changent seulement s'ils sont donnés. */
  touchWorkstationBrowser(input: { id: string; label: string | null; version: string | null; at: number }): void {
    this.execute(
      `INSERT INTO workstation_browsers (id, label, version, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET last_seen_at = MAX(last_seen_at, excluded.last_seen_at),
         label = COALESCE(excluded.label, label), version = COALESCE(excluded.version, version)`,
      input.id,
      input.label,
      input.version,
      input.at,
      input.at,
    );
  }

  getWorkstationBrowser(id: string): WorkstationBrowserRow | null {
    const row = this.selectOne("SELECT * FROM workstation_browsers WHERE id = ?", id);
    return row ? browserOf(row) : null;
  }

  /** Les navigateurs connus, du premier vu au dernier. */
  listWorkstationBrowsers(): WorkstationBrowserRow[] {
    return this.selectAll("SELECT * FROM workstation_browsers ORDER BY first_seen_at, id").map(browserOf);
  }
}
