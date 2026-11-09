// Le relecteur « humain pressé » : avant qu'une escalade parte vers l'humain, un modèle rapide (tier `fast`
// et son repli) juge UNE chose — la carte se comprend-elle en 30 secondes sans connaître le code ? Il peut
// réécrire `headline`, `stake`, `established` et les `impact`, jamais les options (card.ts `applyReview`).
// Il ne refuse jamais une carte et ne la bloque jamais : coupé, en échec, en retard ou non conforme, la carte
// part telle que l'agent l'a écrite, marquée « non relue » (`reviewed: false`).
import * as fs from "node:fs";
import * as path from "node:path";
import { applyReview } from "./card.ts";
import type { CardDraft } from "./card.ts";
import type { HarnessContext } from "./context.ts";
import type { RunRow, StepRow } from "./db.ts";
import { cardReaderPrompt } from "./prompts.ts";
import { hostToolsFor, runnerUnit } from "./runner.ts";
import { RunnerSession } from "./runner-session.ts";

export type ReviewedCard = { draft: CardDraft; reviewed: boolean };

let readings = 0;

/** La carte relue (ou, à défaut, celle de l'agent). Ne rejette jamais. */
export async function reviewCard(
  ctx: HarnessContext,
  run: RunRow,
  step: StepRow,
  draft: CardDraft,
): Promise<ReviewedCard> {
  const { config } = ctx;
  const unread: ReviewedCard = { draft, reviewed: false };
  if (!config.review.cardReader) return unread;
  const repo = ctx.repo(run.repo);
  readings += 1;
  const name = `_carte-${run.id}-${readings}`;
  const cwd = path.join(config.worktreesDir, repo.name, name);
  const abort = new AbortController();
  const rewrite: { args: Record<string, unknown> | null } = { args: null };
  const session = new RunnerSession(
    ctx,
    { repo, cwd, memory: false },
    {
      onHostTool: async (tool, args) => {
        if (tool !== "card_review") return { text: `outil inconnu : ${tool}`, isError: true };
        rewrite.args = args;
        return { text: "relecture reçue. Termine ton tour." };
      },
      event: () => {},
    },
  );
  const ms = config.review.cardReaderSec * 1000;
  const work = (async (): Promise<void> => {
    try {
      fs.mkdirSync(cwd, { recursive: true });
      await session.open("fast", `${runnerUnit(run.id, step.id)}-carte-${readings}`, abort.signal);
      await session.setHostTools(hostToolsFor("carte"));
      await session.prompt(cardReaderPrompt(draft), abort.signal, Date.now() + ms);
    } finally {
      await session.stop();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  })();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), ms);
  });
  try {
    const outcome = await Promise.race([work.then(() => "done" as const), late]);
    if (outcome === "late") throw new Error(`relecture trop lente (${config.review.cardReaderSec} s)`);
  } catch (err) {
    ctx.log(`run ${run.id} : carte non relue — ${err instanceof Error ? err.message : String(err)}`, {
      level: "warn",
      runId: run.id,
      repo: run.repo,
    });
    return unread;
  } finally {
    clearTimeout(timer);
    // Un relecteur en retard est arrêté ; son échec tardif n'intéresse plus personne.
    abort.abort();
    work.catch(() => {});
  }
  const rewritten = rewrite.args === null ? null : applyReview(draft, rewrite.args);
  return rewritten === null ? unread : { draft: rewritten, reviewed: true };
}
