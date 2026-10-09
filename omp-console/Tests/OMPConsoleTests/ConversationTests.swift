// Preuves des textes de la conversation (S-15 de omp-console-redesign) : le
// Markdown en ligne d'un message, ses blocs Markdown (S-19 R1), le verbe d'un
// appel d'outil, l'état du fil.

import Synchronization
import Testing
@testable import OMPConsole
import ConsoleCore

@Test("omp-console-redesign/S-15 : un message rend son Markdown en ligne")
func conversationRendersInlineMarkdown() {
    #expect(String(ConversationText.attributed("**gras** et `code`").characters) == "gras et code")
    #expect(String(ConversationText.attributed("a < b").characters) == "a < b")
}

@Test("omp-console-redesign/S-18 : le Markdown d'un message est mémoïsé dans un cache borné")
func inlineMarkdownIsMemoizedAndBounded() {
    // Le cache réel rend le même rendu qu'une analyse directe.
    let text = "Un **gras** et un [lien](https://example.com)"
    #expect(ConversationText.attributed(text) == ConversationText.parseInlineMarkdown(text))
    #expect(ConversationText.attributed(text) == ConversationText.attributed(text))

    let calls = Mutex(0)
    let memo = BoundedMemo<Int>(capacity: 4) { key in
        calls.withLock { $0 += 1 }
        return key.count
    }
    // Même texte ⇒ même résultat, analysé UNE fois.
    #expect(memo.value(for: "abc") == 3)
    #expect(memo.value(for: "abc") == 3)
    #expect(calls.withLock { $0 } == 1)

    // Cent textes distincts : le cache ne dépasse jamais sa capacité.
    for n in 0..<100 {
        _ = memo.value(for: String(repeating: "x", count: n))
        #expect(memo.count <= 4)
    }
    // Un texte resservi pendant que d'autres arrivent reste en cache…
    let kept = "toujours lu"
    _ = memo.value(for: kept)
    let before = calls.withLock { $0 }
    for n in 0..<10 {
        _ = memo.value(for: "neuf \(n)")
        _ = memo.value(for: kept)
    }
    #expect(calls.withLock { $0 } == before + 10)
    // … et un texte oublié est simplement recalculé, au même résultat.
    #expect(memo.value(for: "abc") == 3)
}

@Test("omp-console-redesign/S-19 : un message de l'agent se découpe en blocs Markdown, mémoïsés par texte")
func agentMessageBlocksAreMemoizedAndBounded() {
    let text = """
    ## Bilan

    - **un**
    - deux

    | Lot | État |
    |-----|------|
    | BR-1 | fait |
    """
    let blocks = ConversationText.blocks(text)
    #expect(blocks.count == 3)
    guard blocks.count == 3,
          case let .heading(level, title) = blocks[0],
          case let .list(items) = blocks[1],
          case let .table(table) = blocks[2]
    else {
        Issue.record("attendu titre, liste, tableau ; obtenu \(blocks)")
        return
    }
    #expect(level == 2)
    #expect(String(title.characters) == "Bilan")
    #expect(items.map(\.marker) == [.bullet, .bullet])
    #expect(items.map { $0.depth } == [0, 0])
    #expect(table.headers.map { String($0.characters) } == ["Lot", "État"])
    #expect(table.rows.map { $0.map { String($0.characters) } } == [["BR-1", "fait"]])

    // Même texte ⇒ même découpe, égale à une analyse directe.
    #expect(ConversationText.blocks(text) == blocks)
    #expect(blocks == MarkdownDocument.blocks(text))

    // Le cache réel reste borné quand le fil dépasse sa capacité.
    let cache = ConversationText.blocksCache
    for n in 0...(cache.capacity + 16) {
        _ = ConversationText.blocks("message \(n)")
    }
    #expect(cache.count <= cache.capacity)
    #expect(ConversationText.blocks(text) == blocks)
}

@Test("omp-console-redesign/S-15 : un appel d'outil se nomme par son verbe, un outil inconnu par son nom")
func toolCallIsNamedByItsVerb() {
    #expect(ToolVerb.title("read") == "Lecture")
    #expect(ToolVerb.symbol("read") == "doc.text")
    #expect(ToolVerb.title("inconnu") == "inconnu")
    #expect(ToolVerb.symbol("inconnu") == "wrench.and.screwdriver")
}

@Test("omp-console-redesign/S-15 : l'état du fil se dit en mots")
func threadStateIsSaidInWords() {
    // L'erreur de lecture prime, même sur un fil qui suit le direct et a des faits.
    #expect(
        ConversationText.status(state: .unreadable("EACCES"), following: true, isEmpty: false, runEnded: false)
            == ConsoleStatus(text: "Erreur de lecture", tone: .danger)
    )
    #expect(
        ConversationText.status(state: .waiting, following: true, isEmpty: true, runEnded: false)
            == ConsoleStatus(text: "Démarrage", tone: .info)
    )
    // Des faits déjà lus, fichier momentanément absent : le fil reste « En direct ».
    #expect(
        ConversationText.status(state: .waiting, following: true, isEmpty: false, runEnded: false)
            == ConsoleStatus(text: "En direct", tone: .success)
    )
    #expect(
        ConversationText.status(state: .ready, following: true, isEmpty: true, runEnded: false)
            == ConsoleStatus(text: "En direct", tone: .success)
    )
    // Hors du direct, aucun mot : le bouton « Revenir au direct » dit l'état.
    #expect(ConversationText.status(state: .ready, following: false, isEmpty: false, runEnded: false) == nil)
    // L'erreur de lecture prime même hors du direct.
    #expect(
        ConversationText.status(state: .unreadable("EACCES"), following: false, isEmpty: false, runEnded: false)
            == ConsoleStatus(text: "Erreur de lecture", tone: .danger)
    )
}

@Test("ios-viewer-en-direct-sur-session-finie/AC-1 : un run fini ne dit jamais « En direct », même suivi du bas actif")
func endedRunThreadNeverSaysLive() {
    #expect(ConversationText.status(state: .ready, following: true, isEmpty: false, runEnded: true) == nil)
    // Fichier momentanément absent d'un run fini : aucun mot.
    #expect(ConversationText.status(state: .waiting, following: true, isEmpty: false, runEnded: true) == nil)
    // Jamais « Démarrage » pour un run fini.
    #expect(ConversationText.status(state: .waiting, following: true, isEmpty: true, runEnded: true) == nil)
    // L'erreur de lecture prime toujours.
    #expect(
        ConversationText.status(state: .unreadable("EACCES"), following: true, isEmpty: false, runEnded: true)
            == ConsoleStatus(text: "Erreur de lecture", tone: .danger)
    )
}

@Test("ios-viewer-en-direct-sur-session-finie/AC-2 : un run vivant suivi garde « En direct »")
func liveRunThreadKeepsLive() {
    #expect(
        ConversationText.status(state: .ready, following: true, isEmpty: false, runEnded: false)
            == ConsoleStatus(text: "En direct", tone: .success)
    )
}

@Test("ios-viewer-en-direct-sur-session-finie/AC-1 : RunChoice.hasEnded — introuvable et clos = fini, vivant (même périmé) = non")
func runChoiceHasEnded() {
    func run(_ state: RunChoiceState, stale: Bool = false) -> RunChoice {
        RunChoice(
            id: "/s.jsonl", sessionFile: "/s.jsonl", label: "depot/f",
            repo: "depot", featureTitle: "f", startedAtMs: 0, phase: .impl,
            state: state, isStale: stale,
            target: ViewerTarget(sessionFile: "/s.jsonl", title: "t")
        )
    }
    #expect(RunChoice.hasEnded(nil))
    #expect(RunChoice.hasEnded(run(.ended(.done))))
    #expect(RunChoice.hasEnded(run(.ended(.failed))))
    #expect(!RunChoice.hasEnded(run(.live(.running))))
    #expect(!RunChoice.hasEnded(run(.live(.waiting))))
    #expect(!RunChoice.hasEnded(run(.live(.running), stale: true)))
}
