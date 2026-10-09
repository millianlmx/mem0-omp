import Testing

@testable import ConsoleCore
@testable import OMPConsoleIOS

/// Les preuves Swift des libellés de dépôt de la feuille « Nouvelle feature » :
/// le nom du dossier, élargi pour les seuls homonymes, jamais un chemin absolu.
@Suite("ios-nouvelle-feature-formulaire — les libellés de dépôt")
struct IOSNewFeatureSheetTests {
    @Test("ios-nouvelle-feature-formulaire/AC-4 : le nom du dossier, un complément pour les seuls homonymes")
    func repoChoicesUseFolderNames() {
        let choices = KanbanLaunchRepos.choices(["/a/x/mem0-omp", "/b/y/mem0-omp", "/c/autre"])
        #expect(choices.map(\.label) == ["mem0-omp (x)", "mem0-omp (y)", "autre"])
        #expect(Set(choices.map(\.label)).count == choices.count)
        #expect(choices.allSatisfy { !$0.label.hasPrefix("/") })
    }

    @Test("ios-nouvelle-feature-formulaire/AC-4 : le complément s'élargit jusqu'à distinguer les homonymes")
    func repoChoicesWidenUntilDistinct() {
        #expect(
            KanbanLaunchRepos.choices(["/a/x/mem0-omp", "/b/x/mem0-omp"]).map(\.label)
                == ["mem0-omp (a/x)", "mem0-omp (b/x)"])
        #expect(
            KanbanLaunchRepos.choices(["/x/mem0-omp", "/a/x/mem0-omp"]).map(\.label)
                == ["mem0-omp (x)", "mem0-omp (a/x)"])
        #expect(KanbanLaunchRepos.choices(["/c/autre/"]).map(\.label) == ["autre"])
        #expect(KanbanLaunchRepos.choices([]).isEmpty)
        #expect(KanbanLaunchRepos.choices(["/a/x/r", "/a/x/r"]).map(\.label) == ["r"])
    }

    @Test("ios-nouvelle-feature-formulaire/AC-6 : la valeur lancée reste le chemin complet")
    func repoChoicesKeepTheRealRoot() {
        let roots = ["/a/x/mem0-omp", "/b/y/mem0-omp", "/a/x/mem0-omp", "/c/autre"]
        let choices = KanbanLaunchRepos.choices(roots)
        #expect(choices.map(\.root) == ["/a/x/mem0-omp", "/b/y/mem0-omp", "/c/autre"])
        #expect(choices.map(\.id) == choices.map(\.root))
    }

    @Test("ios-nouvelle-feature-formulaire/AC-10 : la recette -pipelines.recipe force les données de la feuille")
    func pipelinesRecipeResolves() {
        #expect(IOSPipelinesRecipe.resolve([PipelinesText.recipeFlag, "choisi"]) == .choisi)
        #expect(
            IOSPipelinesRecipe.resolve([PipelinesText.recipeFlag, "vide", PipelinesText.recipeFlag, "rempli"])
                == .rempli)
        #expect(
            IOSPipelinesRecipe.resolve([PipelinesText.recipeFlag, "rempli", PipelinesText.recipeFlag, "inconnue"])
                == .rempli)
        #expect(IOSPipelinesRecipe.resolve([PipelinesText.recipeFlag, "inconnue"]) == nil)
        #expect(IOSPipelinesRecipe.resolve([PipelinesText.recipeFlag]) == nil)
        #expect(IOSPipelinesRecipe.resolve([]) == nil)

        // Les dépôts forcés passent par le calcul RÉEL des libellés.
        #expect(
            KanbanLaunchRepos.choices(IOSPipelinesRecipe.vide.repos).map(\.label)
                == ["mem0-omp (Archives)", "mem0-omp (Projets)", "site-vitrine"])
        #expect(IOSPipelinesRecipe.vide.repo.isEmpty)
        #expect(IOSPipelinesRecipe.vide.title.isEmpty && IOSPipelinesRecipe.vide.need.isEmpty)
        #expect(IOSPipelinesRecipe.choisi.repos.contains(IOSPipelinesRecipe.choisi.repo))
        #expect(IOSPipelinesRecipe.rempli.repo == IOSPipelinesRecipe.choisi.repo)
        #expect(IOSPipelinesRecipe.rempli.need.split(separator: "\n").count == 12)
    }
}
