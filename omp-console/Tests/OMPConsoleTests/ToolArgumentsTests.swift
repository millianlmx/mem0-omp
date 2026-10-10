// Preuves du modèle de lecture des arguments d'un appel d'outil
// (visionneuse-appels-outils-lisibles, S-2, S-3, S-4) : AC-1 à AC-9 côté noyau.
//
// Un critère par test, titré `visionneuse-appels-outils-lisibles/AC-<n>` : c'est
// ce titre que /review relit par grep. Les sources sont écrites À LA MAIN, dans
// l'ordre voulu : c'est l'ordre du texte que le modèle doit restituer.

import ConsoleCore
import Testing

/// Les lignes d'un appel classé en champs ; échec du test sinon.
private func fields(_ tool: String, _ source: String) throws -> [ArgumentLine] {
    let arguments = ToolArguments(tool: tool, source: source)
    guard case .fields(let lines) = arguments.content else {
        Issue.record("attendu des champs pour \(source), obtenu \(arguments.content)")
        throw FieldsMissing()
    }
    return lines
}

private struct FieldsMissing: Error {}

private func line(_ id: String, _ depth: Int, _ label: String, _ value: ArgumentValue) -> ArgumentLine {
    ArgumentLine(id: id, depth: depth, label: label, value: value)
}

@Suite("Arguments d'un appel d'outil en clé/valeur")
struct ToolArgumentsTests {

    @Test("visionneuse-appels-outils-lisibles/AC-1 : arguments imbriqués en hiérarchie, sans syntaxe JSON")
    func nestedArgumentsBecomeAHierarchy() throws {
        let source = #"{"edits":[{"path":"a.swift","op":"replace"}],"options":{"dryRun":true}}"#
        let arguments = ToolArguments(tool: "multi_edit", source: source)

        #expect(
            arguments.content
                == .fields([
                    line("0", 0, "edits", .group),
                    line("0.0", 1, "1", .group),
                    line("0.0.0", 2, "path", .plain("a.swift")),
                    line("0.0.1", 2, "op", .plain("replace")),
                    line("1", 0, "options", .group),
                    line("1.0", 1, "dryRun", .plain("oui")),
                ])
        )
        #expect(arguments.raw == source)

        // Aucune accolade, crochet ni guillemet ajouté par le rendu.
        let lines = try fields("multi_edit", source)
        for shown in lines {
            var texts = [shown.label]
            switch shown.value {
            case .group: break
            case .plain(let text), .code(let text): texts.append(text)
            }
            for text in texts {
                #expect(!text.contains { "{}[]\"".contains($0) }, "syntaxe JSON visible : \(text)")
            }
        }
    }

    @Test("visionneuse-appels-outils-lisibles/AC-2 : les clés gardent l'ordre d'origine, pas l'ordre alphabétique")
    func keysKeepTheirOriginalOrder() throws {
        let lines = try fields("task", #"{"zeta":1,"alpha":2}"#)
        #expect(lines.map(\.label) == ["zeta", "alpha"])

        // Doublons : deux lignes, dans l'ordre du texte.
        let duplicated = try fields("task", #"{"k":1,"k":2}"#)
        #expect(duplicated.map(\.value) == [.plain("1"), .plain("2")])
    }

    @Test("visionneuse-appels-outils-lisibles/AC-3 : objet dans liste dans objet — hiérarchie, numéros dès 1, oui/non, ordre")
    func nestedRenderingRegressionsAreCaught() throws {
        let lines = try fields("task", #"{"a":{"liste":[{"x":false},{"y":true}]},"b":0}"#)

        // (1) La hiérarchie : chaque niveau d'imbrication ajoute un retrait.
        #expect(lines.map(\.depth) == [0, 1, 2, 3, 2, 3, 0])
        #expect(lines.map(\.id) == ["0", "0.0", "0.0.0", "0.0.0.0", "0.0.1", "0.0.1.0", "1"])
        // (2) Les éléments de liste sont numérotés à partir de 1.
        #expect(lines.filter { $0.depth == 2 }.map(\.label) == ["1", "2"])
        // (3) Les booléens sont rendus oui/non.
        #expect(lines.first { $0.label == "x" }?.value == .plain("non"))
        #expect(lines.first { $0.label == "y" }?.value == .plain("oui"))
        // (4) L'ordre d'origine : `a` avant `b`.
        #expect(lines.filter { $0.depth == 0 }.map(\.label) == ["a", "b"])

        #expect(
            lines == [
                line("0", 0, "a", .group),
                line("0.0", 1, "liste", .group),
                line("0.0.0", 2, "1", .group),
                line("0.0.0.0", 3, "x", .plain("non")),
                line("0.0.1", 2, "2", .group),
                line("0.0.1.0", 3, "y", .plain("oui")),
                line("1", 0, "b", .plain("0")),
            ]
        )

        // Les valeurs simples restantes : null, vide, nombre au lexème d'origine.
        let simple = try fields("task", #"{"n":null,"o":{},"l":[],"s":"","f":-0.5e3}"#)
        #expect(simple.map(\.value) == [.plain("—"), .plain("vide"), .plain("vide"), .plain("vide"), .plain("-0.5e3")])
    }

    /// La table de S-3, recopiée : la source de vérité du test est la spec.
    private static let frenchLabels: [(tool: String, key: String, label: String)] = [
        ("read", "path", "Fichier"), ("read", "offset", "À partir de la ligne"), ("read", "limit", "Nombre de lignes"),
        ("write", "path", "Fichier"), ("write", "content", "Contenu"),
        ("edit", "path", "Fichier"), ("edit", "old_string", "Ancien texte"), ("edit", "new_string", "Nouveau texte"),
        ("edit", "replace_all", "Remplacer partout"), ("edit", "input", "Modifications"),
        ("edit", "edits", "Modifications"), ("edit", "op", "Opération"), ("edit", "rename", "Nouveau nom"),
        ("edit", "diff", "Différence"),
        ("bash", "command", "Commande"), ("bash", "timeout", "Délai maximal (s)"), ("bash", "cwd", "Dossier"),
        ("bash", "pty", "Terminal interactif"), ("bash", "async", "En arrière-plan"), ("bash", "name", "Nom du service"),
        ("bash", "ready", "Prêt quand"), ("bash", "log", "Ligne attendue"), ("bash", "port", "Port"),
        ("bash", "host", "Hôte"),
        ("grep", "pattern", "Motif"), ("grep", "path", "Emplacement"), ("grep", "paths", "Emplacements"),
        ("grep", "case", "Sensible à la casse"), ("grep", "gitignore", "Respecter .gitignore"),
        ("grep", "skip", "Résultats sautés"),
        ("glob", "path", "Motif"), ("glob", "hidden", "Fichiers cachés"), ("glob", "gitignore", "Respecter .gitignore"),
        ("glob", "limit", "Nombre maximal"),
    ] + ["read", "write", "edit", "bash", "grep", "glob"].map { ($0, "i", "Intention") }

    @Test("visionneuse-appels-outils-lisibles/AC-4 : chaque clé connue des six outils porte son libellé français")
    func knownKeysOfTheSixToolsAreLabelled() throws {
        for entry in Self.frenchLabels {
            let label = ToolArgumentsText.label(tool: entry.tool, key: entry.key)
            #expect(label == entry.label, "\(entry.tool).\(entry.key)")
            #expect(label != entry.key, "\(entry.tool).\(entry.key) garde son nom brut")
        }

        // De bout en bout, y compris en profondeur (`op` sous `edits`).
        let edit = try fields("edit", #"{"path":"a.swift","edits":[{"op":"update","diff":"+x"}],"i":"corriger"}"#)
        #expect(edit.map(\.label) == ["Fichier", "Modifications", "1", "Opération", "Différence", "Intention"])
        let bash = try fields("bash", #"{"command":"ls","ready":{"port":8080,"host":"localhost"}}"#)
        #expect(bash.map(\.label) == ["Commande", "Prêt quand", "Port", "Hôte"])
    }

    @Test("visionneuse-appels-outils-lisibles/AC-5 : un autre outil, ou une clé inconnue, garde le nom brut exact")
    func otherToolsAndUnknownKeysKeepTheRawKey() throws {
        let task = try fields("task", #"{"context":"x","tasks":[{"name":"A"}]}"#)
        #expect(task.map(\.label) == ["context", "tasks", "1", "name"])
        #expect(try fields("read", #"{"selector":"x"}"#).map(\.label) == ["selector"])
        // Le nom d'outil est comparé exactement, casse comprise.
        #expect(try fields("Read", #"{"path":"a"}"#).map(\.label) == ["path"])
        // Un autre outil n'a jamais de valeur « code ».
        #expect(try fields("task", #"{"command":"ls"}"#).map(\.value) == [.plain("ls")])
    }

    @Test("visionneuse-appels-outils-lisibles/AC-6 : une commande de 40 lignes porte un extrait de 4 lignes, la valeur garde les 40")
    func longValuesCarryAnExcerpt() throws {
        let command = (1...40).map { "ligne \($0)" }.joined(separator: "\n")
        let source = #"{"command":""# + command.replacingOccurrences(of: "\n", with: "\\n") + #""}"#
        let lines = try fields("bash", source)
        #expect(lines.count == 1)
        #expect(lines.first?.value == .code(command))
        #expect(lines.first?.excerpt == "ligne 1\nligne 2\nligne 3\nligne 4…")

        // 4 lignes courtes : montrées entières.
        #expect(ToolArguments.excerpt(of: "a\nb\nc\nd") == nil)
        // 280 caractères : entière ; 281 : 280 + « … ».
        #expect(ToolArguments.excerpt(of: String(repeating: "x", count: 280)) == nil)
        #expect(ToolArguments.excerpt(of: String(repeating: "x", count: 281)) == String(repeating: "x", count: 280) + "…")
        // Une fin de ligne CRLF compte pour une seule coupure.
        #expect(ToolArguments.excerpt(of: "a\r\nb\r\nc\r\nd\r\ne") == "a\nb\nc\nd…")
        // Un groupe n'a jamais d'extrait.
        let group = try fields("task", #"{"o":{"k":1}}"#)
        #expect(group.first?.value == .group)
        #expect(group.first?.excerpt == nil)
    }

    @Test("visionneuse-appels-outils-lisibles/AC-7 : commande et contenu à chasse fixe, chemin et booléen en police système")
    func codeValuesAreMonospaced() throws {
        #expect(
            try fields("bash", #"{"command":"ls","timeout":5,"async":true}"#).map(\.value)
                == [.code("ls"), .plain("5"), .plain("oui")]
        )
        #expect(try fields("write", #"{"path":"a.txt","content":"x"}"#).map(\.value) == [.plain("a.txt"), .code("x")])
        // `path` : un chemin pour read (système), un motif pour glob (chasse fixe).
        #expect(try fields("read", #"{"path":"a.txt"}"#).map(\.value) == [.plain("a.txt")])
        #expect(try fields("glob", #"{"path":"**/*.swift"}"#).map(\.value) == [.code("**/*.swift")])
        #expect(try fields("grep", #"{"pattern":"foo","case":false}"#).map(\.value) == [.code("foo"), .plain("non")])
        #expect(
            try fields("edit", #"{"old_string":"a","new_string":"b","replace_all":null}"#).map(\.value)
                == [.code("a"), .code("b"), .plain("—")]
        )
    }

    @Test("visionneuse-appels-outils-lisibles/AC-8 : « Aucun argument » sans détail brut ; « Arguments illisibles » avec le texte d'origine")
    func emptyAndUnreadableArguments() {
        for source in ["null", "{}", #""""#, #""{}""#, #""   ""#] {
            let arguments = ToolArguments(tool: "read", source: source)
            #expect(arguments.content == .none, "\(source)")
            #expect(arguments.raw == nil, "\(source)")
        }

        let truncated = ToolArguments(tool: "read", source: #""{\"path\":""#)
        #expect(truncated.content == .unreadable)
        #expect(truncated.raw == #"{"path":"#)

        for source in ["[1]", "3", "true", #"{"path":"#] {
            let arguments = ToolArguments(tool: "read", source: source)
            #expect(arguments.content == .unreadable, "\(source)")
            #expect(arguments.raw == source, "\(source)")
        }
    }

    @Test("visionneuse-appels-outils-lisibles/AC-9 : le détail brut est la source complète, dans l'ordre d'origine")
    func rawIsTheOriginalSource() throws {
        let source = #"{"zeta":1,"alpha":{"b":true,"a":null}}"#
        #expect(ToolArguments(tool: "task", source: source).raw == source)

        // Des arguments transportés en chaîne : le brut est l'objet décodé.
        let encoded = ToolArguments(tool: "read", source: #""{\"path\":\"a\",\"i\":\"lire\"}""#)
        #expect(encoded.raw == #"{"path":"a","i":"lire"}"#)
        #expect(
            encoded.content
                == .fields([
                    line("0", 0, "Fichier", .plain("a")),
                    line("1", 0, "Intention", .plain("lire")),
                ])
        )

        // La rangée du fil calcule sa lecture depuis sa source.
        let row = ToolCallRow(callId: "c1", name: "read", target: "a", argumentsJSON: source, result: nil, ask: nil)
        #expect(row.readableArguments == ToolArguments(tool: "read", source: source))
        #expect(row.readableArguments.raw == source)
    }
}
