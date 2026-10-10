// LA FIXTURE DE RÉFÉRENCE partagée de l'Accueil (S-2) : un instantané du magasin,
// décodé d'un littéral JSON, et le contrat de référence du même fixture.
//
// Son CONTENU est figé par ses EFFETS attendus, pas par ses octets : depuis
// `HomeParity.snapshot`, `KanbanBoard.build` puis `HomePresentation.dashboard`
// produisent exactement —
//   • 5 attentions : une question en vol portée par un run `pendingAsk`
//     (question + deux options), un jalon specs, un jalon revue, une feature
//     `cache-sessions` en échec et une feature `export-csv` bloquée (toutes deux
//     relançables : lot vivant, slug et dépôt connus) ;
//   • 2 « En cours » : les runs vivants `aaaaaaaaaaaaaaa2` et `aaaaaaaaaaaaaaa3` ;
//   • 1 « À reprendre » : la feature `reprise` du lot au pilote mort (lot dont
//     `owner.pid` est mort, donc `resumable`) ;
//   • 1 « Pas commencées » : la feature `theme-sombre`, jamais lancée ;
//   • 2 livraisons récentes : une feature de projet à `prUrl` non nulle, et une
//     pipeline close portant une PR ;
//   • `showsRepo == true` (au moins deux dépôts), `attentionCount == 5` et
//     `counts == (5, 2)`.
//
// Il porte aussi une entrée d'historique terminée : `HomePresentation` ignore
// `.termineeSansPr` (comportement inchangé), elle est donc présente sans compter.
//
// La feature « specs-a-valider » porte un `worktree` NON VIDE : c'est ce qui rend
// `ContractDocument.moment(for:) == .specs`, donc le bouton « Lire le contrat » et
// la feuille Contrat exerçables depuis la fixture (aucun autre champ n'en dépend).
//
// Les deux coques (macOS et iOS) nomment `HomeParity.snapshot` : c'est la garde
// de parité des faits.
//
// VIT DANS `ConsoleCore`.

import Foundation

public enum HomeParity {
    /// L'ardoise de la fixture, horloge fixe et `stateDir` vide (le cas de l'app
    /// iOS, qui ne connaît aucun répertoire d'état local). Elle nourrit les
    /// crochets de recette `-home.recipe` des deux coques.
    public static let board: KanbanBoardState = KanbanBoardState.derive(
        snapshot: snapshot,
        nowMs: 1_700_000_000_000,
        stateDir: "",
        isAlive: .transported(snapshot),
        prFacts: [:]
    )

    /// L'ardoise réduite à UNE attente, aux deux « En cours », à la pause et à la
    /// feature pas commencée : comptes (1, 2) de l'item de barre de menus.
    public static var menuBarBoard: KanbanBoardState {
        reduced { dashboard in
            Array(dashboard.attention.prefix(1).map(\.card)) + dashboard.running + dashboard.paused
                + dashboard.notStarted
        }
    }

    /// L'ardoise réduite à la pause et à la feature pas commencée : comptes
    /// (0, 0), aucun chiffre sur l'item de barre de menus.
    public static var pausedOnlyBoard: KanbanBoardState {
        reduced { dashboard in dashboard.paused + dashboard.notStarted }
    }

    /// `board` dont on ne garde que les cartes choisies, dans l'ordre de l'ardoise.
    private static func reduced(_ keep: (HomeDashboard) -> [KanbanCard]) -> KanbanBoardState {
        guard case .board(var reduced) = board else { return board }
        let kept = Set(keep(HomePresentation.dashboard(reduced)).map(\.id))
        reduced.cards = reduced.cards.filter { kept.contains($0.id) }
        return .board(reduced)
    }

    /// L'instantané de référence, décodé du littéral JSON ci-dessous
    /// (`StoreSnapshot` est `Codable`).
    public static let snapshot: StoreSnapshot = {
        guard let data = json.data(using: .utf8) else {
            fatalError("HomeParity : le littéral JSON n'est pas de l'UTF-8")
        }
        do {
            return try JSONDecoder().decode(StoreSnapshot.self, from: data)
        } catch {
            fatalError("HomeParity : instantané de référence illisible — \(error)")
        }
    }()

    /// Le contrat de référence du même fixture : les quatre sections requises
    /// (`## Besoins`, `## Critères d'acceptation`, `## Spécifications`,
    /// `## Lots`) portent un texte reconnaissable.
    public static let contractMarkdown = """
    # Contrat de référence (HomeParity)

    ## Besoins

    - Parité de l'Accueil entre la coque macOS et l'app iOS.

    ## Critères d'acceptation

    - Le même instantané produit les mêmes faits des deux côtés.

    ## Spécifications

    - Une seule dérivation partagée, `HomePresentation`.

    ## Lots

    - BR-1 : déplacer le noyau de l'Accueil dans ConsoleCore.
    """

    private static let json = """
    {
      "root": "present",
      "running": {
        "availability": "present",
        "discardedEntries": [],
        "entries": [
          {
            "id": "aaaaaaaaaaaaaaa1",
            "cwd": "/tmp/omp-parity/alpha",
            "label": "alpha/question",
            "phase": "req",
            "state": "running",
            "phaseStartedAt": 1700000000000,
            "updatedAt": 1700000000000,
            "ownerPid": 1,
            "inbox": "/tmp/omp-parity/state/inbox/aaaaaaaaaaaaaaa1",
            "pendingAsk": {
              "toolCallId": "call-1",
              "id": "ask-1",
              "question": "On livre avec le drapeau activé ?",
              "options": [
                { "label": "Avec le drapeau" },
                { "label": "Sans le drapeau", "description": "livrer d'abord" }
              ]
            },
            "isStale": false
          },
          {
            "id": "aaaaaaaaaaaaaaa2",
            "cwd": "/tmp/omp-parity/beta",
            "label": "beta/live",
            "phase": "impl",
            "state": "running",
            "phaseStartedAt": 1700000000000,
            "updatedAt": 1700000000000,
            "ownerPid": 1,
            "isStale": false
          },
          {
            "id": "aaaaaaaaaaaaaaa3",
            "cwd": "/tmp/omp-parity/beta-indexation",
            "label": "beta/indexation",
            "phase": "specs",
            "state": "running",
            "phaseStartedAt": 1700000000000,
            "updatedAt": 1700000000000,
            "ownerPid": 1,
            "isStale": false
          }
        ]
      },
      "history": {
        "availability": "present",
        "discardedEntries": [],
        "entries": [
          {
            "id": "bbbbbbbbbbbbbbb1",
            "cwd": "/tmp/omp-parity/archive",
            "label": "archive/terminee",
            "phase": "review",
            "finalState": "done",
            "phaseStartedAt": 1700000000000,
            "endedAt": 1700000100000
          }
        ]
      },
      "lots": {
        "availability": "present",
        "discardedEntries": [],
        "lots": [
          {
            "id": "ccccccccccccccc1",
            "repoRoot": "/tmp/omp-parity/alpha",
            "status": "running",
            "reviewCap": 1,
            "slotCap": 4,
            "recapAt": null,
            "owner": { "pid": 1 },
            "createdAt": 1700000000000,
            "launchedAt": 1700000000000,
            "features": [
              {
                "slug": "specs-a-valider",
                "name": "Specs à valider",
                "branch": "feat/specs-a-valider",
                "worktree": "/tmp/omp-parity/alpha/specs-a-valider",
                "deps": [],
                "origin": "session",
                "state": "waiting",
                "phase": "specs",
                "waitKind": "specs",
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
                "slug": "revue-a-accepter",
                "name": "Revue à accepter",
                "branch": "feat/revue-a-accepter",
                "worktree": "",
                "deps": [],
                "origin": "session",
                "state": "waiting",
                "phase": "review",
                "waitKind": "review",
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
                "slug": "cache-sessions",
                "name": "Cache des sessions",
                "branch": "feat/cache-sessions",
                "worktree": "",
                "deps": [],
                "origin": "session",
                "state": "failed",
                "phase": "impl",
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
                "slug": "export-csv",
                "name": "Export CSV",
                "branch": "feat/export-csv",
                "worktree": "",
                "deps": [],
                "origin": "session",
                "state": "blocked",
                "phase": "specs",
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
                "slug": "theme-sombre",
                "name": "Thème sombre",
                "branch": "feat/theme-sombre",
                "worktree": "",
                "deps": [],
                "origin": "session",
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
              }
            ],
            "isStale": false
          },
          {
            "id": "ccccccccccccccc2",
            "repoRoot": "/tmp/omp-parity/beta",
            "status": "running",
            "reviewCap": 1,
            "slotCap": 4,
            "recapAt": null,
            "owner": { "pid": 0 },
            "createdAt": 1700000000000,
            "launchedAt": 1700000000000,
            "features": [
              {
                "slug": "reprise",
                "name": "Reprise",
                "branch": "feat/reprise",
                "worktree": "",
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
                "addedAt": 1700000000000,
                "sinceAt": 1700000000000,
                "updatedAt": 1700000000000
              }
            ],
            "isStale": true
          },
          {
            "id": "ccccccccccccccc3",
            "repoRoot": "/tmp/omp-parity/livre",
            "status": "running",
            "reviewCap": 1,
            "slotCap": 4,
            "recapAt": null,
            "owner": { "pid": 1 },
            "createdAt": 1700000000000,
            "launchedAt": 1700000000000,
            "features": [
              {
                "slug": "terminee",
                "name": "Terminée",
                "branch": "feat/terminee",
                "worktree": "",
                "deps": [],
                "origin": "session",
                "state": "done",
                "phase": "release",
                "waitKind": null,
                "prUrl": "https://example.com/pr/43",
                "pendingTexts": [],
                "fixes": 0,
                "reviewRuns": 0,
                "unreadableRuns": 0,
                "lastBlockers": 0,
                "addedAt": 1700000000000,
                "sinceAt": 1700000000000,
                "updatedAt": 1700000000000,
                "endedAt": 1700000200000
              }
            ],
            "isStale": false
          }
        ]
      },
      "projects": {
        "availability": "present",
        "discardedEntries": [],
        "projects": [
          {
            "repoKey": "ddddddddddddddd1",
            "repoRoot": "/tmp/omp-parity/projet",
            "relayKey": "/tmp/omp-parity/state/projects/ddddddddddddddd1@1",
            "purpose": "Parité de l'Accueil",
            "function": "Fixture de référence",
            "status": "running",
            "segments": [
              {
                "name": "Livraisons",
                "features": [
                  {
                    "slug": "livree-avec-pr",
                    "intention": "Une feature livrée avec sa PR.",
                    "status": "pr",
                    "prUrl": "https://example.com/pr/42",
                    "failure": null,
                    "removedReason": null,
                    "updatedAt": 1700000000000
                  }
                ]
              }
            ],
            "current": 0,
            "base": null,
            "hostSession": null,
            "createdAt": 1700000000000,
            "updatedAt": 1700000000000
          }
        ]
      },
      "inbox": {
        "availability": "present",
        "discardedEntries": [],
        "boxes": []
      },
      "audit": {
        "availability": "present",
        "discardedEntries": [],
        "relays": []
      }
    }
    """
}
