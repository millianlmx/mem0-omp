// LA FIXTURE DE PARITÉ des libellés Mac/iOS (feature
// parite-mac-des-correctifs-ios, C-5) : les ENTRÉES seulement — dépôts dont
// deux homonymes, sélecteurs de modèle dont des noms partagés (entre
// fournisseurs, et chez un même fournisseur), un nom blanc, et les deux modèles
// d'une feature. Les sorties attendues sont épinglées par une suite de chaque
// côté (PariteMacTests, IOSPariteMacTests) : un même jeu d'entrée doit donner
// les mêmes libellés sur les deux apps. L'ardoise des voies est
// `KanbanBoardParity.board`.
//
// VIT DANS `ConsoleCore` (patron `HomeParity`, `KanbanBoardParity`).

import Foundation

public enum KanbanLabelParity {
    /// Trois dépôts, dont deux homonymes (« mem0-omp ») aux parents distincts.
    public static let repoRoots = [
        "/Users/demo/Projets/mem0-omp",
        "/Users/demo/Archives/mem0-omp",
        "/Users/demo/Projets/site-vitrine",
    ]

    /// Les sélecteurs du catalogue : « Claude Opus 4.7 » chez deux fournisseurs,
    /// « GPT-4o » deux fois chez un même fournisseur, et un sélecteur sans nom.
    public static let modelSelectors = [
        "anthropic/claude-opus-4-7",
        "anthropic/claude-opus-5-5",
        "github-copilot/claude-opus-4.7",
        "github-copilot/gpt-4o",
        "github-copilot/gpt-4o-2024-05-13",
        "lm-studio/qwen3-coder-30b",
    ]

    /// Les noms lisibles du catalogue (`omp models --json`), dont un nom blanc.
    public static let modelNames: [String: String] = [
        "anthropic/claude-opus-4-7": "Claude Opus 4.7",
        "anthropic/claude-opus-5-5": "Claude Opus 5.5",
        "github-copilot/claude-opus-4.7": "Claude Opus 4.7",
        "github-copilot/gpt-4o": "GPT-4o",
        "github-copilot/gpt-4o-2024-05-13": "GPT-4o",
        "lm-studio/blanc": "  ",
    ]

    /// Les deux modèles d'une feature : l'un nommé, l'autre sans nom.
    public static let models = ModelSlots(reqSpecs: "anthropic/claude-opus-5-5", implReview: "lm-studio/qwen3-coder-30b")
}
