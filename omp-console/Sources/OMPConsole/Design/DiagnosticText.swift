// Les mots du bouton « Copier le diagnostic » (S-1 de jargon-technique-expose-mac-et-ios).
//
// Le Mac montre une phrase lisible ; le détail brut (pid, chemin, stderr, URL,
// code HTTP) ne s'affiche jamais : il se COPIE, pour être joint à un signalement.
// Mots propres au Mac : iOS n'a pas ce bouton, il ne montre que la phrase.

import Foundation

enum DiagnosticText {
    static let copy = "Copier le diagnostic"
    static let copied = "Diagnostic copié"
    static let copyHelp = "Copier le détail technique, à joindre à un signalement"
}
