// Le socle du Store : la connexion SQLite, les migrations, les transactions et
// l'annonce des événements aux abonnés. Les couches de domaine (runs.ts → push.ts)
// en héritent et ne passent que par ses requêtes protégées.
import { DatabaseSync } from "node:sqlite";
import type { EventRow } from "./journal.ts";
import { MIGRATIONS } from "./schema.ts";
import type { Row, SqlValue } from "./sql.ts";

export class StoreCore {
  readonly db: DatabaseSync;
  protected readonly now: () => number;
  readonly #listeners = new Set<(event: EventRow) => void>();
  /** La profondeur de transaction ; les événements écrits dedans ne partent qu'au COMMIT. */
  #depth = 0;
  #held: EventRow[] = [];

  /**
   * `beforeMigrate` : appelé une fois avant de migrer une base qui a déjà un schéma
   * (`from` > 0), la sauvegarde de main.ts ; s'il lève, rien n'est migré.
   */
  constructor(
    file: string,
    now: () => number = Date.now,
    options: { beforeMigrate?: (db: DatabaseSync, from: number, to: number) => void } = {},
  ) {
    this.db = new DatabaseSync(file);
    this.now = now;
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    try {
      this.#migrate(options.beforeMigrate);
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  #migrate(beforeMigrate?: (db: DatabaseSync, from: number, to: number) => void): void {
    const current = Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version);
    if (current > 0 && current < MIGRATIONS.length) beforeMigrate?.(this.db, current, MIGRATIONS.length);
    for (let version = current; version < MIGRATIONS.length; version++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[version] ?? "");
        this.db.exec(`PRAGMA user_version = ${version + 1}`);
      });
    }
  }

  get schemaVersion(): number {
    return Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Exécute `fn` dans une transaction : tout ou rien. Réentrante (une transaction
   * imbriquée rejoint celle qui l'englobe). Les abonnés du journal ne voient les
   * événements écrits dedans qu'au COMMIT : un rollback n'annonce jamais rien.
   */
  transaction<T>(fn: () => T): T {
    if (this.#depth > 0) {
      this.#depth++;
      try {
        return fn();
      } finally {
        this.#depth--;
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.#depth = 1;
    let result: T;
    try {
      result = fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      this.#held = [];
      throw err;
    } finally {
      this.#depth = 0;
    }
    const held = this.#held;
    this.#held = [];
    for (const event of held) this.notify(event);
    return result;
  }

  protected selectAll(sql: string, ...params: SqlValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }
  protected selectOne(sql: string, ...params: SqlValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }
  protected execute(
    sql: string,
    ...params: SqlValue[]
  ): { lastInsertRowid: number | bigint; changes: number | bigint } {
    return this.db.prepare(sql).run(...params);
  }

  /** Annonce un événement écrit : tout de suite, ou au COMMIT de la transaction en cours. */
  protected emit(event: EventRow): void {
    if (this.#depth > 0) this.#held.push(event);
    else this.notify(event);
  }

  /** Annonce un événement aux abonnés, sans attendre de COMMIT (les éphémères). */
  protected notify(event: EventRow): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        /* un abonné fautif ne casse ni l'écriture ni les autres abonnés */
      }
    }
  }

  onEvent(listener: (event: EventRow) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
