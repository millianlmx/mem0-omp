// La « Demande » d'omp-harness (`/v1/intake*`) vue par le popup : le contrat JSON rendu
// par le serveur et ce que le popup en affiche. Le popup ne parle jamais au serveur : le
// service worker pose, relit, confirme, annule ou répond, et garde dans `chrome.storage.local`
// (clé `intake`) l'identifiant de la dernière demande posée depuis ce navigateur, jusqu'à ce
// qu'elle soit confirmée, annulée ou remplacée.

/** La clé `chrome.storage.local` de la dernière demande posée par le popup. */
export const INTAKE_KEY = "intake";

export type IntakeState = "classifying" | "clarifying" | "planned" | "answered" | "confirmed" | "cancelled" | "failed";

export type IntakePlan = {
  kind: string;
  repo: string | null;
  title: string;
  statement: string;
  creates: string;
};

export type Intake = {
  id: string;
  state: IntakeState;
  kind: string | null;
  plan: IntakePlan | null;
  question: string | null;
  answer: string | null;
  reason: string | null;
  created: { kind: string; id: string } | null;
};

/** Une demande confirmée ou annulée n'est plus suivie par le popup. */
export function settled(intake: Intake): boolean {
  return intake.state === "confirmed" || intake.state === "cancelled";
}

const KINDS: Record<string, string> = {
  feature: "Feature",
  bug: "Bug",
  audit: "Audit",
  schedule: "Planification",
  workstation_request: "Demande au poste",
  question: "Question",
};

/** Ce que le popup affiche d'une demande (textContent seulement) et les gestes qu'il offre. */
export type IntakeDisplay = {
  status: string;
  lines: string[];
  note: string;
  confirm: boolean;
  cancel: boolean;
  answer: boolean;
};

export function describeIntake(intake: Intake): IntakeDisplay {
  const display: IntakeDisplay = { status: "", lines: [], note: "", confirm: false, cancel: false, answer: false };
  const plan = intake.plan;
  if (plan !== null && (intake.state === "planned" || intake.state === "confirmed")) {
    display.lines.push(`Type : ${KINDS[plan.kind] ?? plan.kind}`);
    if (plan.repo) display.lines.push(`Dépôt : ${plan.repo}`);
    if (plan.title) display.lines.push(`Titre : ${plan.title}`);
    display.lines.push(`À créer : ${plan.creates}`);
  }
  switch (intake.state) {
    case "classifying":
      display.status = "Classement en cours…";
      display.cancel = true;
      break;
    case "clarifying":
      display.status = "Une précision est demandée";
      if (intake.question) display.lines.push(intake.question);
      display.answer = true;
      display.cancel = true;
      break;
    case "planned":
      display.status = "Plan prêt";
      // Le jeton d'appairage n'est jamais approbateur : seul un client approbateur confirme une demande au poste.
      if (plan?.kind === "workstation_request") display.note = "À confirmer depuis l'app omp-console.";
      else display.confirm = true;
      display.cancel = true;
      break;
    case "answered":
      display.status = "Réponse";
      if (intake.answer) display.lines.push(intake.answer);
      display.cancel = true;
      break;
    case "failed":
      display.status = "Échec du classement";
      if (intake.reason) display.lines.push(intake.reason);
      display.cancel = true;
      break;
    case "confirmed":
      display.status = "Confirmée";
      if (intake.created) display.lines.push(`Créé : ${intake.created.kind} ${intake.created.id}`);
      break;
    case "cancelled":
      display.status = "Annulée";
      break;
  }
  return display;
}
