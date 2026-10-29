// Script de contenu déclaré dans manifest.json. Les scripts de contenu MV3 sont des
// scripts classiques (ni `import` ni `export`) : celui-ci charge le module d'observation,
// déclaré dans `web_accessible_resources`, qui s'exécute dans le même monde isolé.
void import(chrome.runtime.getURL("content/observe.js")).then((module: { start(): void }) => module.start());
