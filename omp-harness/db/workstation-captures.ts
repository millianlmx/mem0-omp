// Le poste de travail, ce qu'on en montre : la capture d'écran de chaque action
// `screenshot` réussie, gardée `workstation.captureRetentionHours` heures (le JPEG tel que
// l'extension l'a capturé, en base64). Les règles (rétention, accès) vivent dans
// workstation.ts ; la couche du dessous (workstation-meetings.ts) tient meetings et profil.
import { WorkstationMeetingStore } from "./workstation-meetings.ts";
import { num, str } from "./sql.ts";

/** Une capture gardée : l'action qui l'a prise, quand, et l'image JPEG en base64. */
export type WorkstationCapture = { seq: number; at: number; mimeType: string; image: string };

export class WorkstationCaptureStore extends WorkstationMeetingStore {
  /** Garde la capture d'une action (une seule par action : la dernière remplace). */
  putWorkstationCapture(seq: number, image: string, mimeType = "image/jpeg"): void {
    this.execute(
      `INSERT INTO workstation_captures (seq, at, mime_type, image) VALUES (?, ?, ?, ?)
       ON CONFLICT (seq) DO UPDATE SET at = excluded.at, mime_type = excluded.mime_type, image = excluded.image`,
      seq,
      this.now(),
      mimeType,
      image,
    );
  }

  getWorkstationCapture(seq: number): WorkstationCapture | null {
    const row = this.selectOne("SELECT * FROM workstation_captures WHERE seq = ?", seq);
    return row
      ? { seq: num(row, "seq"), at: num(row, "at"), mimeType: str(row, "mime_type"), image: str(row, "image") }
      : null;
  }

  /** La rétention des captures : plus vieilles que `before` (ms), effacées. Rend le nombre. */
  pruneWorkstationCaptures(before: number): number {
    return Number(this.execute("DELETE FROM workstation_captures WHERE at < ?", before).changes);
  }
}
