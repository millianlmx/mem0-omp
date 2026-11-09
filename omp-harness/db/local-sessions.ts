// Les sessions omp locales (sur le poste du développeur) qui se signalent au serveur, et les jetons
// push-to-start des Live Activities. Tables `local_sessions` et `push_start_tokens`.
import { ProposalStore } from "./proposals.ts";

export class LocalSessionStore extends ProposalStore {}
