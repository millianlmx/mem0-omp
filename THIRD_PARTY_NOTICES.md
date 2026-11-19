# Avis sur les composants tiers

Ce dépôt est sous licence MIT (voir `LICENSE`). Le service mémoire reprend du texte et des calculs d'une bibliothèque Python tierce, sous licence Apache-2.0. Le code et les commentaires du dépôt y renvoient ici sans la nommer.

## mem0ai 2.2.1 (Apache-2.0)

- Bibliothèque : `mem0ai`, version 2.2.1.
- Licence : Apache License 2.0, <https://www.apache.org/licenses/LICENSE-2.0>.
- Ce qui est repris :
  - le texte de l'invite d'extraction additive, octet pour octet : `memory-stack/memory-rs/src/modele/prompts/additive_extraction.txt` ;
  - les calculs de la recherche hybride (score additif, normalisation BM25, fusion des classements) et le calcul du graphe de proximité, reproduits dans `memory-stack/memory-rs/src/classement/recherche.rs`, `memory-stack/memory-rs/src/classement/bm25.rs` et `memory-stack/memory-rs/src/stockage/graphe.rs` ;
  - la lecture de la réponse du modèle (retrait des blocs de code, extraction du JSON), reproduite dans `memory-stack/memory-rs/src/modele/extraction.rs`.
- Les fichiers repris n'ont pas été modifiés dans leur texte ; les calculs sont réécrits en Rust.
