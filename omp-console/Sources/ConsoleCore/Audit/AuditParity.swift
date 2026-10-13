// LA FIXTURE DE RÉFÉRENCE partagée de la section Audit (audit-panel-in-omp-console
// S-5) : un instantané du magasin, décodé d'un littéral JSON, sur le patron de
// `HomeParity`.
//
// Son CONTENU est figé par ses EFFETS attendus : depuis `AuditParity.snapshot`,
// `AuditBoard.of` rend exactement trois audits, du plus récent au plus ancien —
//   • `analysingId` (« recette-analyse ») : `analysing`, orientation
//     « accessibilité VoiceOver », sans proposition ;
//   • `proposedId` (« recette-propositions ») : `proposed`, 5 propositions
//     (2 faiblesses, 3 features), dont `cache-demarrage` déjà dans le lot du
//     dépôt (`taken`) ;
//   • `launchedId` (« recette-suivi ») : `launched`, 4 features — `journal-erreurs`
//     en cours, `reprise-pipeline` escaladée (sorte `question`, 2 options),
//     `rapport-erreurs` à PR créée, `alerte-quota` annulée —, une proposition
//     non lancée avec son motif, et 3 décisions de l'arbitre.
//
// Les deux coques nomment `AuditParity.snapshot` : la recette `-surface.recipe
// audit` du Mac et `-audit.recipe` de l'iPhone.
//
// VIT DANS `ConsoleCore`.

import Foundation

public enum AuditParity {
    /// « recette-analyse » : l'audit dont l'analyse est en cours.
    public static let analysingId = "a0d1700000000003"
    /// « recette-propositions » : l'audit qui attend la validation de son brief.
    public static let proposedId = "a0d1700000000002"
    /// « recette-suivi » : l'audit dont les pipelines sont lancées.
    public static let launchedId = "a0d1700000000001"

    /// L'ardoise de la fixture.
    public static let board: AuditBoard = AuditBoard.of(snapshot)

    /// L'instantané de référence, décodé du littéral JSON ci-dessous
    /// (`StoreSnapshot` est `Codable`).
    public static let snapshot: StoreSnapshot = {
        guard let data = json.data(using: .utf8) else {
            fatalError("AuditParity : le littéral JSON n'est pas de l'UTF-8")
        }
        do {
            return try JSONDecoder().decode(StoreSnapshot.self, from: data)
        } catch {
            fatalError("AuditParity : instantané de référence illisible — \(error)")
        }
    }()

    private static let json = """
    {
      "root": "present",
      "running": { "availability": "present", "discardedEntries": [], "entries": [] },
      "history": { "availability": "present", "discardedEntries": [], "entries": [] },
      "lots": {
        "availability": "present",
        "discardedEntries": [],
        "lots": [
          {
            "id": "ddddddddddddddd1",
            "repoRoot": "/tmp/omp-audit-parity/depot",
            "status": "running",
            "reviewCap": 1,
            "slotCap": 4,
            "recapAt": null,
            "owner": { "pid": 1 },
            "createdAt": 1700000000000,
            "launchedAt": 1700000000000,
            "isStale": false,
            "features": [
              {
                "slug": "cache-demarrage",
                "name": "Cache du démarrage",
                "branch": "feat/cache-demarrage",
                "worktree": "",
                "deps": [],
                "origin": "panneau",
                "state": "pending",
                "phase": "req",
                "waitKind": null,
                "pendingTexts": [],
                "fixes": 0,
                "reviewRuns": 0,
                "unreadableRuns": 0,
                "lastBlockers": 0,
                "addedAt": 1700000000000,
                "sinceAt": 1700000000000,
                "updatedAt": 1700000000000
              },
              {
                "slug": "journal-erreurs",
                "name": "journal-erreurs",
                "branch": "feat/journal-erreurs",
                "worktree": "/tmp/omp-audit-parity/depot/journal-erreurs",
                "deps": [],
                "origin": "session",
                "state": "running",
                "phase": "impl",
                "waitKind": null,
                "pendingTexts": [],
                "fixes": 0,
                "reviewRuns": 0,
                "unreadableRuns": 0,
                "lastBlockers": 0,
                "auditSession": "/tmp/omp-audit-parity/state/audits/a0d1700000000001",
                "addedAt": 1700000001000,
                "sinceAt": 1700000001000,
                "updatedAt": 1700000001000
              },
              {
                "slug": "reprise-pipeline",
                "name": "reprise-pipeline",
                "branch": "feat/reprise-pipeline",
                "worktree": "/tmp/omp-audit-parity/depot/reprise-pipeline",
                "deps": [],
                "origin": "session",
                "state": "waiting",
                "phase": "req",
                "waitKind": "answer",
                "waitPrompt": "Faut-il reprendre automatiquement une pipeline interrompue ?",
                "pendingTexts": [],
                "fixes": 0,
                "reviewRuns": 0,
                "unreadableRuns": 0,
                "lastBlockers": 0,
                "auditSession": "/tmp/omp-audit-parity/state/audits/a0d1700000000001",
                "escalation": {
                  "key": "question:reprise-pipeline:1700000001500",
                  "kind": "question",
                  "phase": "req",
                  "question": "Faut-il reprendre automatiquement une pipeline interrompue ?",
                  "options": ["Oui, automatiquement", "Non, sur demande"],
                  "reason": "Le brief ne dit rien de la reprise automatique.",
                  "at": 1700000005000
                },
                "addedAt": 1700000001000,
                "sinceAt": 1700000001500,
                "updatedAt": 1700000005000
              },
              {
                "slug": "rapport-erreurs",
                "name": "rapport-erreurs",
                "branch": "feat/rapport-erreurs",
                "worktree": "/tmp/omp-audit-parity/depot/rapport-erreurs",
                "deps": [],
                "origin": "session",
                "state": "done",
                "phase": "release",
                "waitKind": null,
                "pendingTexts": [],
                "prUrl": "https://example.com/pr/7",
                "fixes": 0,
                "reviewRuns": 1,
                "unreadableRuns": 0,
                "lastBlockers": 0,
                "auditSession": "/tmp/omp-audit-parity/state/audits/a0d1700000000001",
                "addedAt": 1700000001000,
                "sinceAt": 1700000004600,
                "updatedAt": 1700000004600,
                "endedAt": 1700000004600
              },
              {
                "slug": "alerte-quota",
                "name": "alerte-quota",
                "branch": "feat/alerte-quota",
                "worktree": "/tmp/omp-audit-parity/depot/alerte-quota",
                "deps": [],
                "origin": "session",
                "state": "cancelled",
                "phase": "specs",
                "waitKind": null,
                "pendingTexts": [],
                "fixes": 0,
                "reviewRuns": 0,
                "unreadableRuns": 0,
                "lastBlockers": 0,
                "auditSession": "/tmp/omp-audit-parity/state/audits/a0d1700000000001",
                "addedAt": 1700000001000,
                "sinceAt": 1700000002000,
                "updatedAt": 1700000002000,
                "endedAt": 1700000002000
              }
            ]
          }
        ]
      },
      "projects": { "availability": "present", "discardedEntries": [], "projects": [] },
      "inbox": { "availability": "present", "discardedEntries": [], "boxes": [] },
      "audit": { "availability": "present", "discardedEntries": [], "relays": [] },
      "audits": {
        "availability": "present",
        "discardedEntries": [],
        "records": [
          {
            "id": "a0d1700000000001",
            "repoRoot": "/tmp/omp-audit-parity/depot",
            "repoKey": "0123456789abcdef",
            "key": "/tmp/omp-audit-parity/state/audits/a0d1700000000001",
            "orientation": "fiabilité des pipelines",
            "status": "launched",
            "createdAt": 1700000000000,
            "updatedAt": 1700000005000,
            "proposal": {
              "elements": [
                { "kind": "weakness", "slug": "erreurs-perdues", "intention": "Les erreurs des pipelines ne laissent aucune trace.", "deps": [] },
                { "kind": "feature", "slug": "journal-erreurs", "intention": "Journaliser les erreurs de chaque phase.", "deps": [] },
                { "kind": "feature", "slug": "reprise-pipeline", "intention": "Reprendre une pipeline interrompue.", "deps": [] },
                { "kind": "feature", "slug": "rapport-erreurs", "intention": "Résumer les erreurs dans la PR.", "deps": ["journal-erreurs"] },
                { "kind": "feature", "slug": "alerte-quota", "intention": "Prévenir avant d’atteindre un quota.", "deps": [] },
                { "kind": "feature", "slug": "tableau-fiabilite", "intention": "Tableau de fiabilité par dépôt.", "deps": ["alerte-quota"] }
              ],
              "briefDraft": "# Brief — audit depot\\n\\n## But\\nFiabiliser les pipelines.\\n\\n## Fonction\\nJournaliser, reprendre et signaler.\\n\\n## Décisions\\n- (aucune)\\n\\n## Contraintes\\n- (aucune)\\n\\n## Non-objectifs\\n- (aucune)\\n\\n## Orientation\\nfiabilité des pipelines\\n\\n## Constats\\n- erreurs-perdues — Les erreurs des pipelines ne laissent aucune trace.\\n"
            },
            "launches": [
              { "slug": "journal-erreurs", "launched": true, "reason": null, "state": "running", "phase": "impl", "prUrl": null },
              { "slug": "reprise-pipeline", "launched": true, "reason": null, "state": "waiting", "phase": "req", "prUrl": null },
              { "slug": "rapport-erreurs", "launched": true, "reason": null, "state": "done", "phase": "release", "prUrl": "https://example.com/pr/7" },
              { "slug": "alerte-quota", "launched": true, "reason": null, "state": "cancelled", "phase": "specs", "prUrl": null },
              { "slug": "tableau-fiabilite", "launched": false, "reason": "lancement refusé : la feature existe déjà dans le lot", "state": null, "phase": null, "prUrl": null }
            ],
            "failure": null
          },
          {
            "id": "a0d1700000000002",
            "repoRoot": "/tmp/omp-audit-parity/depot",
            "repoKey": "0123456789abcdef",
            "key": "/tmp/omp-audit-parity/state/audits/a0d1700000000002",
            "orientation": "performances du démarrage",
            "status": "proposed",
            "createdAt": 1700000006000,
            "updatedAt": 1700000006500,
            "proposal": {
              "elements": [
                { "kind": "weakness", "slug": "relecture-complete", "intention": "Le démarrage relit tous les fichiers de session.", "deps": [] },
                { "kind": "weakness", "slug": "cache-ignore", "intention": "Les erreurs du cache sont ignorées sans trace.", "deps": [] },
                { "kind": "feature", "slug": "cache-demarrage", "intention": "Mettre en cache l’index des sessions.", "deps": [] },
                { "kind": "feature", "slug": "index-sessions", "intention": "Indexer les sessions par date.", "deps": ["cache-demarrage"] },
                { "kind": "feature", "slug": "mesure-demarrage", "intention": "Mesurer la durée du démarrage.", "deps": [] }
              ],
              "briefDraft": "# Brief — audit depot\\n\\n## But\\nAccélérer le démarrage.\\n\\n## Fonction\\nMettre en cache et mesurer.\\n\\n## Décisions\\n- (aucune)\\n\\n## Contraintes\\n- (aucune)\\n\\n## Non-objectifs\\n- (aucune)\\n\\n## Orientation\\nperformances du démarrage\\n\\n## Constats\\n- relecture-complete — Le démarrage relit tous les fichiers de session.\\n- cache-ignore — Les erreurs du cache sont ignorées sans trace.\\n"
            },
            "launches": [],
            "failure": null
          },
          {
            "id": "a0d1700000000003",
            "repoRoot": "/tmp/omp-audit-parity/depot",
            "repoKey": "0123456789abcdef",
            "key": "/tmp/omp-audit-parity/state/audits/a0d1700000000003",
            "orientation": "accessibilité VoiceOver",
            "status": "analysing",
            "createdAt": 1700000007000,
            "updatedAt": 1700000007000,
            "launches": [],
            "failure": null
          }
        ],
        "decisions": [
          { "auditId": "a0d1700000000001", "slug": "journal-erreurs", "phase": "req", "kind": "question", "question": "Quels journaux faut-il couvrir ?", "answer": "Ceux du service, d’après le brief.", "source": "contexte", "at": 1700000002500 },
          { "auditId": "a0d1700000000001", "slug": "journal-erreurs", "phase": "specs", "kind": "jalon", "question": "Valider les specs ?", "answer": "Specs validées : elles couvrent le brief.", "source": "arbitrage", "at": 1700000003500 },
          { "auditId": "a0d1700000000001", "slug": "rapport-erreurs", "phase": "review", "kind": "jalon", "question": "Accepter la revue ?", "answer": "Revue acceptée : aucun bloquant.", "source": "arbitrage", "at": 1700000004500 }
        ]
      }
    }
    """
}
