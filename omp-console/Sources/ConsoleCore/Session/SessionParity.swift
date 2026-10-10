// LA FIXTURE DE RÉFÉRENCE partagée des sessions (S-11) : les lignes JSONL d'une
// session RÉELLE, au format exact de l'hôte, et la charge utile EXACTE que l'API
// distante sert pour ces lignes.
//
// Son CONTENU est figé par ses EFFETS attendus, pas par ses octets : depuis
// `SessionParity.lines`, la coque macOS (SessionReader → SessionRowBuilder) et
// l'app iOS (payloadJSON → SessionWire.entries → SessionRowBuilder) produisent
// exactement les mêmes `SessionRow`. Le fixture couvre ce qu'une parité doit
// prouver :
//   • un en-tête de session (le `cwd` du fixture est la racine de projet, donc
//     les chemins des appels s'affichent relatifs) ;
//   • un message utilisateur ;
//   • un message assistant avec pensées ET trois appels d'outil : `read` (la
//     cible du fil), `edit` (dont le RÉSULTAT porte un diff d'édition), et un
//     `ask` à DEUX options (question mise en évidence, S-7) ;
//   • des résultats d'outil : ceux des deux appels précédents, plus un résultat
//     AUTONOME dont le TEXTE porte un diff unifié (S-6) ;
//   • une compaction et un résumé de branche (les deux marqueurs) ;
//   • un texte d'agent DUPLICQUÉ (l'agent réécrit sa réponse finale mot pour mot
//     après un appel `mem0_add` : la donnée porte le doublon, le fil non) ;
//   • une ligne JSON invalide (écriture concurrente inachevée), une ligne d'un
//     type CONNU hors périmètre (silencieuse) et une ligne d'un type INCONNU
//     (ignorée, nommée).
//
// Les deux coques nomment ce fixture : c'est la garde de parité des faits.
//
// VIT DANS `ConsoleCore` : aucune URL, aucun accès disque — que des chaînes.

import Foundation

public enum SessionParity {
    /// Les lignes de la session de référence, dans l'ordre du fichier.
    public static let lines: [String] = makeLines()

    /// La charge utile que `GET /v1/sessions/{id}` sert pour `lines`, octet pour
    /// octet (clés triées, `HTTPJSON.encode`). C'est le littéral EXACT rendu par
    /// la route — le test de parité le confronte à la pile réelle.
    public static let payloadJSON: String = #"""
    {"entries":[{"index":1,"kind":"user","offset":120,"text":"Bonjour, corrige le fichier src\/app.swift","timestampMs":1790762400000},{"index":2,"kind":"assistant","model":"opencode-go\/deepseek-v4.1-flash","offset":310,"text":"je lis le fichier puis je propose un plan","thinking":"je réfléchis à la correction à appliquer","timestampMs":1790762400000,"toolCalls":[{"arguments":{"i":"lire le fichier","offset":2,"path":"\/tmp\/omp-parity\/src\/app.swift"},"argumentsText":"{\"i\":\"lire le fichier\",\"offset\":2,\"path\":\"\/tmp\/omp-parity\/src\/app.swift\"}","id":"call-read","name":"read"},{"arguments":{"newString":"let ajoute = 3","oldString":"let retire = 2","path":"\/tmp\/omp-parity\/src\/app.swift"},"argumentsText":"{\"newString\":\"let ajoute = 3\",\"oldString\":\"let retire = 2\",\"path\":\"\/tmp\/omp-parity\/src\/app.swift\"}","id":"call-edit","name":"edit"},{"arguments":{"questions":[{"header":"Plan","id":"q1","options":[{"description":"aucune modification","label":"Garder le fichier"},{"label":"Renommer le module"}],"question":"Quel plan préfères-tu ?"}]},"argumentsText":"{\"questions\":[{\"header\":\"Plan\",\"id\":\"q1\",\"options\":[{\"description\":\"aucune modification\",\"label\":\"Garder le fichier\"},{\"label\":\"Renommer le module\"}],\"question\":\"Quel plan préfères-tu ?\"}]}","id":"call-ask","name":"ask"}],"usage":{"cacheRead":64,"cacheWrite":0,"cost":0.0123,"input":1200,"output":80,"totalTokens":1344}},{"callId":"call-read","index":3,"isError":false,"kind":"toolResult","name":"read","offset":1293,"text":"deux lignes lues","timestampMs":1790762400000},{"callId":"call-edit","diff":" 12|let ancien = 1\n-14|let retire = 2\n+16|let ajoute = 3","index":4,"isError":false,"kind":"toolResult","name":"edit","offset":1506,"text":"édition appliquée","timestampMs":1790762400000},{"callId":"call-absent","index":5,"isError":false,"kind":"toolResult","name":"bash","offset":1802,"text":"voici le patch :\ndiff --git a\/src\/app.swift b\/src\/app.swift\nindex 111..222 100644\n--- a\/src\/app.swift\n+++ b\/src\/app.swift\n@@ -1,2 +1,2 @@\n-let a = 1\n+let a = 2\nfin du patch","timestampMs":1790762400000},{"index":6,"kind":"compaction","offset":2189,"text":"contexte compacté à 4 200 jetons","timestampMs":1790762400000,"tokensBefore":4200},{"fromId":"root","index":7,"kind":"branchSummary","offset":2327,"text":"résumé de branche : reprise après compaction","timestampMs":1790762400000},{"index":8,"kind":"assistant","model":"opencode-go\/deepseek-v4.1-flash","offset":2478,"text":"La correction est appliquée.","timestampMs":1790762400000,"toolCalls":[{"arguments":{"scope":"project","text":"la correction est appliquée"},"argumentsText":"{\"scope\":\"project\",\"text\":\"la correction est appliquée\"}","id":"call-memory","name":"mem0_add"}],"usage":{"cacheRead":64,"cacheWrite":0,"cost":0.0123,"input":1200,"output":80,"totalTokens":1344}},{"index":9,"kind":"assistant","model":"opencode-go\/deepseek-v4.1-flash","offset":2938,"text":"La correction est appliquée.","timestampMs":1790762400000,"usage":{"cacheRead":64,"cacheWrite":0,"cost":0.0123,"input":1200,"output":80,"totalTokens":1344}}],"header":{"cwd":"\/tmp\/omp-parity","id":"parity-session-1","timestamp":"2026-09-30T10:00:00.000Z","version":3},"kind":"topLevel","skipped":[{"offset":3271,"reason":"invalidJSON"},{"offset":3547,"reason":"unknownType"}],"truncated":false}
    """#

    /// La racine du projet du fixture : le `cwd` de son en-tête de session, donc
    /// la base des chemins relatifs rendus dans les cibles d'appel.
    public static let projectRoot = "/tmp/omp-parity"

    // MARK: - Fixture

    /// L'horodatage FIXE de toutes les lignes : la parité ne dépend jamais de
    /// l'heure qu'il est (même parti-pris que `HomeParity`).
    private static let stamp = "2026-09-30T10:00:00.000Z"

    private static let model = "opencode-go/deepseek-v4.1-flash"

    /// Le diff d'édition d'OMP (`details.diff`) : `<marqueur><numéro>|<texte>` —
    /// aucune ligne d'en-tête de diff, trois tons seulement.
    public static let editDiff = """
     12|let ancien = 1
    -14|let retire = 2
    +16|let ajoute = 3
    """

    /// Le texte du résultat AUTONOME : de la prose, puis un diff unifié — les
    /// quatre tons (en-têtes de section, retrait, ajout) doivent en sortir.
    public static let patchText = """
    voici le patch :
    diff --git a/src/app.swift b/src/app.swift
    index 111..222 100644
    --- a/src/app.swift
    +++ b/src/app.swift
    @@ -1,2 +1,2 @@
    -let a = 1
    +let a = 2
    fin du patch
    """

    private static func makeLines() -> [String] {
        [
            header(),
            user("Bonjour, corrige le fichier src/app.swift", id: "u1"),
            readingAssistant(),
            toolResult(id: "t1", callId: "call-read", name: "read", body: "deux lignes lues"),
            toolResult(
                id: "t2",
                callId: "call-edit",
                name: "edit",
                body: "édition appliquée",
                diff: editDiff
            ),
            toolResult(
                id: "t3",
                callId: "call-absent",
                name: "bash",
                body: patchText
            ),
            compaction(),
            branchSummary(),
            memoryReply(),
            duplicateReply(),
            invalidJSONLine,
            outOfScopeLine,
            unknownTypeLine,
        ]
    }

    // MARK: - Assemblage des lignes

    private static func json(_ object: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else {
            return "{}"
        }
        return String(decoding: data, as: UTF8.self)
    }

    private static func entry(_ type: String, _ id: String, _ payload: [String: Any]) -> String {
        var object: [String: Any] = ["type": type, "id": id, "timestamp": stamp]
        for (key, value) in payload { object[key] = value }
        return json(object)
    }

    private static func message(_ id: String, _ body: [String: Any]) -> String {
        entry("message", id, ["parentId": NSNull(), "message": body])
    }

    private static func header() -> String {
        entry(
            "session",
            "parity-session-1",
            ["id": "parity-session-1", "cwd": projectRoot, "version": 3]
        )
    }

    private static func user(_ text: String, id: String) -> String {
        message(id, ["role": "user", "content": [["type": "text", "text": text]]])
    }

    private static func assistant(
        id: String,
        text: String,
        thinking: String? = nil,
        calls: [[String: Any]] = []
    ) -> String {
        var content: [[String: Any]] = []
        if let thinking { content.append(["type": "thinking", "thinking": thinking]) }
        content.append(["type": "text", "text": text])
        content.append(contentsOf: calls)
        return message(id, [
            "role": "assistant",
            "model": model,
            "usage": [
                "input": 1200,
                "output": 80,
                "cacheRead": 64,
                "cacheWrite": 0,
                "totalTokens": 1344,
                "cost": ["total": 0.0123],
            ],
            "content": content,
        ])
    }

    private static func call(id: String, name: String, arguments: [String: Any]) -> [String: Any] {
        ["type": "toolCall", "id": id, "name": name, "arguments": arguments]
    }

    /// Le message assistant du fixture : pensées, texte, et les trois appels.
    private static func readingAssistant() -> String {
        assistant(
            id: "a1",
            text: "je lis le fichier puis je propose un plan",
            thinking: "je réfléchis à la correction à appliquer",
            calls: [
                call(
                    id: "call-read",
                    name: "read",
                    arguments: [
                        "path": "\(projectRoot)/src/app.swift",
                        "offset": 2,
                        "i": "lire le fichier",
                    ]
                ),
                call(
                    id: "call-edit",
                    name: "edit",
                    arguments: [
                        "path": "\(projectRoot)/src/app.swift",
                        "oldString": "let retire = 2",
                        "newString": "let ajoute = 3",
                    ]
                ),
                call(
                    id: "call-ask",
                    name: "ask",
                    arguments: [
                        "questions": [
                            [
                                "id": "q1",
                                "header": "Plan",
                                "question": "Quel plan préfères-tu ?",
                                "options": [
                                    ["label": "Garder le fichier", "description": "aucune modification"],
                                    ["label": "Renommer le module"],
                                ],
                            ]
                        ]
                    ]
                ),
            ]
        )
    }

    private static func toolResult(
        id: String,
        callId: String,
        name: String,
        body: String,
        diff: String? = nil,
        isError: Bool = false
    ) -> String {
        var payload: [String: Any] = [
            "role": "toolResult",
            "toolCallId": callId,
            "toolName": name,
            "content": [["type": "text", "text": body]],
        ]
        if let diff { payload["details"] = ["diff": diff] }
        if isError { payload["isError"] = true }
        return message(id, payload)
    }

    private static func compaction() -> String {
        entry(
            "compaction",
            "k1",
            ["summary": "contexte compacté à 4 200 jetons", "tokensBefore": 4200]
        )
    }

    private static func branchSummary() -> String {
        entry(
            "branch_summary",
            "b1",
            ["summary": "résumé de branche : reprise après compaction", "fromId": "root"]
        )
    }

    /// La réponse finale de l'agent, avec son appel `mem0_add`…
    private static func memoryReply() -> String {
        assistant(
            id: "a2",
            text: "La correction est appliquée.",
            calls: [
                call(
                    id: "call-memory",
                    name: "mem0_add",
                    arguments: ["text": "la correction est appliquée", "scope": "project"]
                )
            ]
        )
    }

    /// …puis la MÊME réponse seule : la donnée porte le doublon, le fil ne le
    /// montre qu'une fois (`SessionRowBuilder` replie un texte identique).
    private static func duplicateReply() -> String {
        assistant(id: "a3", text: "La correction est appliquée.")
    }

    /// Une ligne JSON INVALIDE : une écriture concurrente a laissé la ligne
    /// inachevée. Elle est OBTENUE par troncature d'une ligne valide, jamais
    /// recopiée à la main (piège mesuré : dans une chaîne brute, un guillemet
    /// fermant collé au délimiteur est avalé et produit un JSON valide par
    /// accident).
    private static var invalidJSONLine: String {
        String(
            message(
                "coupe",
                ["role": "user", "content": [["type": "text", "text": "inachevé"]]]
            ).dropLast(1)
        )
    }

    /// Un type CONNU mais hors périmètre (`model_change`) : la ligne est
    /// silencieuse — ni entrée, ni ignorée.
    private static var outOfScopeLine: String {
        entry("model_change", "mc1", ["model": model])
    }

    /// Un type INCONNU du lecteur : la ligne est ignorée et son motif est nommé
    /// (`unknownType`), sans jamais gonfler le compte des entrées.
    private static var unknownTypeLine: String {
        entry("observations_partielles", "zz1", ["note": "type inconnu du lecteur"])
    }
}
