import AppIntents
import ConsoleClient

/// La racine de composition du serveur de pipelines : l'instance UNIQUE de l'app,
/// enregistrée pour les App Intents (client-ios-possede-par-la-vue, S-1).
///
/// `OMPConsoleIOSApp.init()` — qui tourne à chaque lancement du processus, y
/// compris un lancement à froid par Siri — crée le modèle, l'enregistre ici, puis
/// passe aux vues l'instance même que les intents résolvent par `AppDependency`.
enum IOSSharedServer {
    /// Enregistre `server` comme dépendance de `manager` et le rend TEL QUEL.
    @MainActor
    static func install(_ server: HarnessModel, in manager: AppDependencyManager) -> HarnessModel {
        manager.add(dependency: server)
        return server
    }
}
