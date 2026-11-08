// Les appareils qui reçoivent les alertes push (APNs, push-type alert) : un jeton par
// appareil, lié au CLIENT qui l'a enregistré — ce que l'appareil reçoit suit ses droits
// (dépôts vus, rôle, approbateur), relus à chaque envoi. Un même jeton enregistré par
// un autre client change de client : un appareil n'a jamais qu'un seul jeu de droits.
import { PushStore } from "./push.ts";
import { str, num } from "./sql.ts";

export type PushEnvironment = "sandbox" | "production";

/** Un appareil enregistré : son jeton APNs, son client, sa passerelle (sandbox : app installée depuis Xcode). */
export type PushDeviceRow = {
  token: string;
  client: string;
  platform: "ios";
  environment: PushEnvironment;
  createdAt: number;
  updatedAt: number;
};

export class PushDeviceStore extends PushStore {
  /** Enregistre un appareil ; un jeton déjà connu passe au client qui l'enregistre. Rend `true` s'il est nouveau. */
  putPushDevice(input: Pick<PushDeviceRow, "token" | "client" | "platform" | "environment">): boolean {
    const at = this.now();
    const known = this.selectAll("SELECT token FROM push_devices WHERE token = ?", input.token).length > 0;
    this.execute(
      `INSERT INTO push_devices (token, client, platform, environment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (token) DO UPDATE SET client = excluded.client, platform = excluded.platform,
       environment = excluded.environment, updated_at = excluded.updated_at`,
      input.token,
      input.client,
      input.platform,
      input.environment,
      at,
      at,
    );
    return !known;
  }

  /** Oublie un appareil ; `client` non nul : seulement s'il est à ce client. Rend `true` si un appareil est parti. */
  deletePushDevice(token: string, client: string | null = null): boolean {
    const result =
      client === null
        ? this.execute("DELETE FROM push_devices WHERE token = ?", token)
        : this.execute("DELETE FROM push_devices WHERE token = ? AND client = ?", token, client);
    return Number(result.changes) > 0;
  }

  /** Les appareils enregistrés, du plus ancien au plus récent. */
  listPushDevices(): PushDeviceRow[] {
    return this.selectAll("SELECT * FROM push_devices ORDER BY created_at, token").map((row) => ({
      token: str(row, "token"),
      client: str(row, "client"),
      platform: str(row, "platform") as PushDeviceRow["platform"],
      environment: str(row, "environment") as PushEnvironment,
      createdAt: num(row, "created_at"),
      updatedAt: num(row, "updated_at"),
    }));
  }
}
