// La confirmation d'une Demande : l'objet de son plan est créé par les chemins existants
// (mêmes entrées, mêmes gardes que les routes), sans en recopier aucun contrôle.
import type { Client } from "./auth.ts";
import type { Actor } from "./context.ts";
import type { IntakePlan } from "./db.ts";
import { newRunInput, requireRepo } from "./input.ts";
import type { Created } from "./intake.ts";
import type { Orchestrator } from "./orchestrator.ts";
import { scheduleInput } from "./schedules.ts";
import { approverFor } from "./workstation.ts";

/** Crée l'objet du plan : `bug` et `feature` un run, `audit`, `schedule` et `workstation_request` le leur. */
export function createFromPlan(orchestrator: Orchestrator, client: Client, actor: Actor, plan: IntakePlan): Created {
  const repo = plan.repo ?? "";
  switch (plan.kind) {
    case "feature":
    case "bug": {
      const input = newRunInput({ repo, title: plan.title, request: plan.statement }, client);
      return { kind: "run", id: orchestrator.createRun(input, actor).id };
    }
    case "audit": {
      requireRepo(client, repo);
      return { kind: "audit", id: orchestrator.audits.create(repo, plan.focus ?? "", actor).id };
    }
    case "schedule": {
      const schedule = plan.schedule as NonNullable<IntakePlan["schedule"]>;
      const target =
        schedule.target === "run"
          ? { kind: "run", repo, title: plan.title, request: plan.statement }
          : schedule.target === "audit"
            ? { kind: "audit", repo, focus: schedule.focus ?? "" }
            : { kind: "issues", repo, ...(schedule.label ? { label: schedule.label } : {}) };
      const input = scheduleInput({ name: plan.title, cron: schedule.cron, target }, client);
      return { kind: "schedule", id: orchestrator.schedules.create(input, actor).id };
    }
    case "workstation_request": {
      const workstation = approverFor(orchestrator.workstation, client);
      return { kind: "workstation_request", id: workstation.createRequest({ instruction: plan.statement }, actor).id };
    }
  }
}
