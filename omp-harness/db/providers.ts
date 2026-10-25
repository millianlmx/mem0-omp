// Les fournisseurs déclarés par l'API et les réglages du serveur.
import { ProjectStore } from "./projects.ts";
import { str, strOrNull, num, numOrNull, json } from "./sql.ts";
import type { Row } from "./sql.ts";

/** Un modèle d'un fournisseur compatible OpenAI, tel que le `models.yml` des runners le déclare. */
export type ProviderModel = { id: string; contextWindow?: number; maxTokens?: number };

/** Un fournisseur déclaré par l'API. `keyHint` : les 4 derniers caractères de sa clé, ou `null` sans clé. */
export type ProviderRow = {
  name: string;
  kind: string;
  baseUrl: string | null;
  api: string | null;
  models: ProviderModel[];
  capacity: number | null;
  refillPerMinute: number | null;
  keyHint: string | null;
  updatedAt: number;
  updatedBy: string | null;
};

function providerOf(row: Row): ProviderRow {
  return {
    name: str(row, "name"),
    kind: str(row, "kind"),
    baseUrl: strOrNull(row, "base_url"),
    api: strOrNull(row, "api"),
    models: json<ProviderModel[]>(row, "models", []),
    capacity: numOrNull(row, "capacity"),
    refillPerMinute: numOrNull(row, "refill_per_minute"),
    keyHint: strOrNull(row, "key_hint"),
    updatedAt: num(row, "updated_at"),
    updatedBy: strOrNull(row, "updated_by"),
  };
}

export class ProviderStore extends ProjectStore {
  listProviders(): ProviderRow[] {
    return this.selectAll("SELECT * FROM providers ORDER BY name").map(providerOf);
  }

  getProvider(name: string): ProviderRow | null {
    const row = this.selectOne("SELECT * FROM providers WHERE name = ?", name);
    return row ? providerOf(row) : null;
  }

  putProvider(input: Omit<ProviderRow, "updatedAt">): ProviderRow {
    this.execute(
      `INSERT INTO providers (name, kind, base_url, api, models, capacity, refill_per_minute, key_hint, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET kind = excluded.kind, base_url = excluded.base_url, api = excluded.api,
         models = excluded.models, capacity = excluded.capacity, refill_per_minute = excluded.refill_per_minute,
         key_hint = excluded.key_hint, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      input.name,
      input.kind,
      input.baseUrl,
      input.api,
      JSON.stringify(input.models),
      input.capacity,
      input.refillPerMinute,
      input.keyHint,
      this.now(),
      input.updatedBy,
    );
    return this.getProvider(input.name) as ProviderRow;
  }

  deleteProvider(name: string): boolean {
    return Number(this.execute("DELETE FROM providers WHERE name = ?", name).changes) > 0;
  }

  getSetting<T>(key: string): T | null {
    const row = this.selectOne("SELECT value FROM settings WHERE key = ?", key);
    return row ? json<T | null>(row, "value", null) : null;
  }

  setSetting(key: string, value: unknown, by: string | null): void {
    this.execute(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      key,
      JSON.stringify(value),
      this.now(),
      by,
    );
  }
}
