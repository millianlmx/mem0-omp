// Le rendu du contenu de la section « Fichiers » (S-18 R5), figé sans rendre de
// vue : le Markdown découpé en blocs, le code découpé en jetons colorables.

import ConsoleCore
import Foundation
import Testing

@testable import OMPConsole

private func plain(_ text: AttributedString) -> String {
    String(text.characters)
}

/// Le texte d'un bloc feuille (paragraphe, titre), `nil` sinon.
private func plain(_ block: MarkdownBlock) -> String? {
    switch block {
    case let .paragraph(text): plain(text)
    case let .heading(_, text): plain(text)
    default: nil
    }
}

// MARK: - Markdown

@Test("omp-console-redesign/S-18 : un titre garde son niveau et son texte en ligne, l'emphase et le code restent dans le paragraphe")
func markdownHeadingsAndInlineParagraph() {
    let blocks = MarkdownDocument.blocks(
        """
        # Titre *mis en avant*

        Un paragraphe avec **gras**, `code` et [lien](https://example.com).
        Même paragraphe.

        ###### Petit
        """
    )
    #expect(blocks.count == 3)
    guard case let .heading(level, text) = blocks[0] else {
        Issue.record("attendu un titre, obtenu \(blocks[0])")
        return
    }
    #expect(level == 1)
    #expect(plain(text) == "Titre mis en avant")
    #expect(text.runs.contains { $0.inlinePresentationIntent == .emphasized })

    guard case let .paragraph(paragraph) = blocks[1] else {
        Issue.record("attendu un paragraphe, obtenu \(blocks[1])")
        return
    }
    // Le saut de ligne simple est une espace : UN paragraphe, pas deux.
    #expect(plain(paragraph) == "Un paragraphe avec gras, code et lien. Même paragraphe.")
    #expect(paragraph.runs.contains { $0.inlinePresentationIntent == .stronglyEmphasized })
    #expect(paragraph.runs.contains { $0.inlinePresentationIntent == .code })
    #expect(paragraph.runs.contains { $0.link == URL(string: "https://example.com") })
    // L'intention de bloc ne fuit pas dans le texte en ligne.
    #expect(paragraph.runs.allSatisfy { $0.presentationIntent == nil })

    guard case let .heading(smallLevel, _) = blocks[2] else {
        Issue.record("attendu un titre, obtenu \(blocks[2])")
        return
    }
    #expect(smallLevel == 6)
}

@Test("omp-console-redesign/S-18 : une liste imbriquée se déplie à plat avec la profondeur de chaque élément, une liste numérotée garde ses vrais numéros")
func markdownNestedLists() {
    let blocks = MarkdownDocument.blocks(
        """
        - a
        - b
          - b1
            1. profond
          - b2
        - c

        3. trois
        4. quatre
        """
    )
    #expect(blocks.count == 2)
    guard case let .list(bullets) = blocks[0], case let .list(numbers) = blocks[1] else {
        Issue.record("attendu deux listes, obtenu \(blocks)")
        return
    }
    #expect(bullets.map(\.depth) == [0, 0, 1, 2, 1, 0])
    #expect(bullets.map { $0.blocks.compactMap(plain) } == [["a"], ["b"], ["b1"], ["profond"], ["b2"], ["c"]])
    #expect(bullets.map(\.marker) == [.bullet, .bullet, .bullet, .number(1), .bullet, .bullet])
    #expect(numbers.map(\.marker) == [.number(3), .number(4)])
    #expect(numbers.map(\.depth) == [0, 0])
    // La puce change avec la profondeur, le numéro reste un numéro.
    #expect(MarkdownListMarker.bullet.label(depth: 0) != MarkdownListMarker.bullet.label(depth: 1))
    #expect(MarkdownListMarker.number(3).label(depth: 2) == "3.")
}

@Test("omp-console-redesign/S-18 : un bloc de code garde son langage et son texte exact, sans le saut final ; sans étiquette, pas de langage")
func markdownCodeBlocks() {
    let blocks = MarkdownDocument.blocks(
        """
        ```swift
        let x = 1
            print(x)
        ```

        ```
        brut
        ```
        """
    )
    #expect(blocks == [
        .code(language: "swift", text: "let x = 1\n    print(x)"),
        .code(language: nil, text: "brut"),
    ])
}

@Test("omp-console-redesign/S-18 : une citation contient ses propres blocs, y compris une liste et une citation imbriquée")
func markdownQuotes() {
    let blocks = MarkdownDocument.blocks(
        """
        > Premier
        > suite
        >
        > - q1
        >
        > > dedans
        """
    )
    #expect(blocks.count == 1)
    guard case let .quote(inner) = blocks.first else {
        Issue.record("attendu une citation, obtenu \(blocks)")
        return
    }
    #expect(inner.count == 3)
    #expect(plain(inner[0]) == "Premier suite")
    guard case let .list(items) = inner[1], case let .quote(nested) = inner[2] else {
        Issue.record("attendu une liste puis une citation, obtenu \(inner)")
        return
    }
    #expect(items.map { $0.blocks.compactMap(plain) } == [["q1"]])
    #expect(nested.compactMap(plain) == ["dedans"])
}

@Test("omp-console-redesign/S-18 : un tableau a ses en-têtes, ses lignes complètes et l'alignement de chaque colonne")
func markdownTables() {
    let blocks = MarkdownDocument.blocks(
        """
        | Nom | Total | Note |
        |:----|------:|:----:|
        | a | **1** | x |
        | b | 2 |
        """
    )
    #expect(blocks.count == 1)
    guard case let .table(table) = blocks.first else {
        Issue.record("attendu un tableau, obtenu \(blocks)")
        return
    }
    #expect(table.headers.map(plain) == ["Nom", "Total", "Note"])
    #expect(table.alignments == [.leading, .trailing, .center])
    // Une cellule manquante est vide : chaque ligne a toutes ses colonnes.
    #expect(table.rows.map { $0.map(plain) } == [["a", "1", "x"], ["b", "2", ""]])
    #expect(table.rows[0][1].runs.contains { $0.inlinePresentationIntent == .stronglyEmphasized })
}

@Test("omp-console-redesign/S-18 : un séparateur est un bloc à part entre deux paragraphes ; un document vide n'a aucun bloc")
func markdownRulesAndEmptyDocument() {
    let blocks = MarkdownDocument.blocks("avant\n\n---\n\naprès")
    #expect(blocks.count == 3)
    #expect(plain(blocks[0]) == "avant")
    #expect(blocks[1] == .rule)
    #expect(plain(blocks[2]) == "après")
    #expect(MarkdownDocument.blocks("").isEmpty)
}

// MARK: - Langue d'un fichier

@Test("omp-console-redesign/S-18 : un commentaire HTML n'apparaît pas dans le rendu, sauf dans un bloc de code")
func markdownHidesHTMLComments() {
    let source = "<!-- mem0:brief v5 -->\n# Titre\n\navant <!-- caché --> après\n\n<!--\nplusieurs\nlignes\n-->\n```\n<!-- gardé -->\n```"
    let stripped = MarkdownDocument.withoutHTMLComments(source)
    #expect(!stripped.contains("mem0:brief"))
    #expect(!stripped.contains("caché"))
    #expect(!stripped.contains("plusieurs"))
    #expect(stripped.contains("avant  après"))
    #expect(stripped.contains("<!-- gardé -->"))
    let blocks = MarkdownDocument.blocks(source)
    guard case .heading(1, let title) = blocks.first else {
        Issue.record("le premier bloc doit être le titre, pas le commentaire : \(blocks)")
        return
    }
    #expect(String(title.characters) == "Titre")
    #expect(MarkdownDocument.withoutHTMLComments("sans commentaire") == "sans commentaire")
}

@Test("omp-console-redesign/S-18 : la langue d'un fichier vient de son extension, ou de son nom pour la configuration du shell")
func codeLanguageFromPath() {
    let cases: [(String, CodeLanguage)] = [
        ("Sources/App/Main.swift", .swift),
        ("src/index.ts", .typescript), ("ui/App.tsx", .typescript), ("a.js", .typescript),
        ("b.mjs", .typescript), ("c.cjs", .typescript), ("d.jsx", .typescript),
        ("tool.py", .python),
        ("run.sh", .shell), ("x.bash", .shell), ("y.zsh", .shell), ("/Users/me/.zshrc", .shell),
        ("package.json", .json),
        ("ci.yml", .yaml), ("conf.YAML", .yaml),
        ("README.md", .markdown), ("notes.markdown", .markdown),
        ("Makefile", .plain), ("image.png", .plain), ("LICENSE", .plain),
    ]
    for (path, language) in cases {
        #expect(CodeLanguage.from(path: path) == language, "\(path)")
    }
    #expect(CodeLanguage.from(fence: "bash") == .shell)
    #expect(CodeLanguage.from(fence: "TypeScript") == .typescript)
    #expect(CodeLanguage.from(fence: "py") == .python)
    #expect(CodeLanguage.from(fence: nil) == .plain)
    #expect(CodeLanguage.from(fence: "brainfuck") == .plain)
}

// MARK: - Coloration

private func joined(_ tokens: [CodeToken]) -> String {
    tokens.map(\.text).joined()
}

private func texts(_ tokens: [CodeToken], _ kind: CodeTokenKind) -> [String] {
    tokens.filter { $0.kind == kind }.map(\.text)
}

@Test("omp-console-redesign/S-18 : Swift — mots-clés, types, attributs, chaînes échappées et multilignes, commentaires, nombres ; la concaténation rend l'entrée")
func swiftTokens() {
    let source = """
    // en tête
    @MainActor
    struct Foo: View {
        let n = 42, r = 0..<3, f = 1.5e3, h = 0xFF
        let s = "a\\"b" /* bloc
        sur deux lignes */
        let t = \"""
        multi "ligne"
        \"""
        #if os(macOS)
    }
    """
    let tokens = CodeHighlighter.tokens(source, language: .swift)
    #expect(joined(tokens) == source)
    #expect(texts(tokens, .comment) == ["// en tête", "/* bloc\n    sur deux lignes */"])
    #expect(texts(tokens, .attribute) == ["@MainActor"])
    #expect(texts(tokens, .type) == ["Foo", "View"])
    #expect(texts(tokens, .number) == ["42", "0", "3", "1.5e3", "0xFF"])
    #expect(texts(tokens, .string) == ["\"a\\\"b\"", "\"\"\"\n    multi \"ligne\"\n    \"\"\""])
    #expect(texts(tokens, .keyword) == ["struct", "let", "let", "let", "#if"])
    // Un identifiant ordinaire n'est ni un mot-clé ni un type.
    #expect(!tokens.contains { $0.text == "n" && $0.kind != .plain })
}

@Test("omp-console-redesign/S-18 : Python — mots-clés, décorateurs, chaînes simples et triples, commentaires #, nombres ; la concaténation rend l'entrée")
func pythonTokens() {
    let source = """
    # entête
    @dataclass
    def f(x: int) -> str:
        return x + 3.5  # fin
    s = '''multi
    ligne'''
    t = "dit \\"oui\\"" if True else None
    """
    let tokens = CodeHighlighter.tokens(source, language: .python)
    #expect(joined(tokens) == source)
    #expect(texts(tokens, .comment) == ["# entête", "# fin"])
    #expect(texts(tokens, .attribute) == ["@dataclass"])
    #expect(texts(tokens, .keyword) == ["def", "return", "if", "True", "else", "None"])
    #expect(texts(tokens, .type) == ["int", "str"])
    #expect(texts(tokens, .number) == ["3.5"])
    #expect(texts(tokens, .string) == ["'''multi\nligne'''", "\"dit \\\"oui\\\"\""])
}

@Test("omp-console-redesign/S-18 : Shell, JSON, YAML — le # n'est un commentaire qu'après un blanc, les clés sont distinguées des valeurs")
func shellJsonYamlTokens() {
    let shell = "#!/bin/zsh\nif [ $# -gt 0 ]; then echo \"${HOME}\" 'brut\\' # note\nfi"
    let shellTokens = CodeHighlighter.tokens(shell, language: .shell)
    #expect(joined(shellTokens) == shell)
    #expect(texts(shellTokens, .comment) == ["#!/bin/zsh", "# note"])
    #expect(texts(shellTokens, .attribute) == ["$#"])
    #expect(texts(shellTokens, .keyword) == ["if", "then", "fi"])
    #expect(texts(shellTokens, .string) == ["\"${HOME}\"", "'brut\\'"])

    // Un # en DÉBUT de ligne (après un saut de ligne) est un commentaire : une
    // apostrophe ou un accent grave qu'il contient n'ouvre aucune chaîne
    // (régression vue à la recette : `# qu'Apple` colorait la suite en chaîne).
    let header = "#!/usr/bin/env bash\n# l'outil `xcodebuild` n'est pas requis\nset -u"
    let headerTokens = CodeHighlighter.tokens(header, language: .shell)
    #expect(joined(headerTokens) == header)
    #expect(texts(headerTokens, .comment) == ["#!/usr/bin/env bash", "# l'outil `xcodebuild` n'est pas requis"])
    #expect(texts(headerTokens, .string).isEmpty)

    let json = "{\"nom\": \"omp\", \"n\": 12, \"ok\": true}"
    let jsonTokens = CodeHighlighter.tokens(json, language: .json)
    #expect(joined(jsonTokens) == json)
    #expect(texts(jsonTokens, .attribute) == ["\"nom\"", "\"n\"", "\"ok\""])
    #expect(texts(jsonTokens, .string) == ["\"omp\""])
    #expect(texts(jsonTokens, .number) == ["12"])
    #expect(texts(jsonTokens, .keyword) == ["true"])

    let yaml = "name: check # ci\njobs:\n  - run: echo a#b\n    retries: 3\n    on: true"
    let yamlTokens = CodeHighlighter.tokens(yaml, language: .yaml)
    #expect(joined(yamlTokens) == yaml)
    #expect(texts(yamlTokens, .attribute) == ["name", "jobs", "run", "retries", "on"])
    #expect(texts(yamlTokens, .comment) == ["# ci"])
    #expect(texts(yamlTokens, .number) == ["3"])
    #expect(texts(yamlTokens, .keyword) == ["true"])
}

@Test("omp-console-redesign/S-18 : un texte brut ou un Markdown source est UN seul jeton, un texte vide aucun")
func plainIsOneToken() {
    let text = "let x = 1 // pas du Swift ici\n# ni un commentaire"
    #expect(CodeHighlighter.tokens(text, language: .plain) == [CodeToken(kind: .plain, text: text)])
    #expect(CodeHighlighter.tokens(text, language: .markdown) == [CodeToken(kind: .plain, text: text)])
    #expect(CodeHighlighter.tokens("", language: .swift).isEmpty)
}

@Test("omp-console-redesign/S-18 : la répartition par ligne coupe un jeton multiligne sans perdre de texte ni de nature, une ligne vide n'a aucun jeton")
func tokensSplitIntoLines() {
    let source = "/* a\n\nb */ x\n"
    let lines = CodeHighlighter.lines(CodeHighlighter.tokens(source, language: .swift))
    #expect(lines == [
        [CodeToken(kind: .comment, text: "/* a")],
        [],
        [CodeToken(kind: .comment, text: "b */"), CodeToken(kind: .plain, text: " x")],
        [],
    ])
    // n sauts de ligne ⇒ n+1 lignes, et le texte se reconstitue.
    #expect(lines.map { $0.map(\.text).joined() }.joined(separator: "\n") == source)
}

// MARK: - Modes du document

@Test("omp-console-redesign/S-18 : un Markdown offre Rendu et Source, un fichier de l'arbre offre son diff, un mode indisponible retombe sur le contenu")
func documentModes() {
    #expect(FilesDocumentMode.available(isMarkdown: true, hasDiff: true) == [.content, .source, .diff])
    #expect(FilesDocumentMode.available(isMarkdown: true, hasDiff: false) == [.content, .source])
    #expect(FilesDocumentMode.available(isMarkdown: false, hasDiff: true) == [.content, .diff])
    #expect(FilesDocumentMode.available(isMarkdown: false, hasDiff: false) == [.content])

    // Le choix « Source » posé sur un Markdown ne s'applique pas à un fichier Swift.
    #expect(FilesDocumentMode.source.effective(in: [.content, .diff]) == .content)
    #expect(FilesDocumentMode.diff.effective(in: [.content, .diff]) == .diff)
    #expect(FilesDocumentMode.diff.effective(in: [.content, .source]) == .content)

    // Le contenu d'un Markdown s'appelle autrement que celui d'un fichier de code.
    #expect(FilesText.title(of: .content, isMarkdown: true) != FilesText.title(of: .content, isMarkdown: false))
}
