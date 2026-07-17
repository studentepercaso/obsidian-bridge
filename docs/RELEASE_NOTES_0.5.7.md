# Obsidian Bridge 0.5.7 — Reliable, sharp installer / Installer affidabile e nitido

## English

Obsidian Bridge 0.5.7 makes the Windows setup self-contained. The installer now verifies the bundled Codex payload, copies only the required manifest, MCP configuration, server bundle, and skill files, and generates its own canonical local marketplace. It no longer depends on an external or dot-prefixed `.agents` directory, so a source checkout, a development archive, and the guided setup layout all resolve safely without the previous “Codex marketplace not found” error.

The WinForms interface opts into Per-Monitor-V2 DPI awareness before creating a window, uses native DPI autoscaling, is resizable and scrollable, uses shorter status text, and reports installation errors once inside the page instead of duplicating them in a blocking dialog. Release packaging now opens and extracts the generated setup ZIP, verifies every required entry, and runs both installer and generated-marketplace self-tests from the extracted package.

The 0.5.6 synchronized-note conflict fix, permission model, write limits, audit behavior, and management protocol are unchanged. Install matching 0.5.7 components, reload Obsidian, refresh the Codex plugin, and start a new task before testing.

## Italiano

Obsidian Bridge 0.5.7 rende autosufficiente l’installazione Windows. L’installer verifica il payload Codex incluso, copia soltanto manifest, configurazione MCP, bundle del server e skill necessari e genera autonomamente il marketplace locale canonico. Non dipende più da una cartella `.agents` esterna o con nome puntato: checkout sorgente, archivio di sviluppo e pacchetto guidato vengono risolti in modo sicuro senza il precedente errore “Marketplace Codex non trovato”.

L’interfaccia WinForms abilita Per-Monitor-V2 prima di creare la finestra, usa il ridimensionamento DPI nativo, è ridimensionabile e scorrevole, mostra stati più brevi e riporta gli errori una sola volta nella pagina senza una finestra modale duplicata. Il packaging ora apre ed estrae lo ZIP appena generato, verifica tutti i file obbligatori ed esegue dal pacchetto estratto sia il self-test dell’installer sia quello del marketplace generato.

La correzione 0.5.6 per le note sincronizzate, il modello dei permessi, i limiti di scrittura, l’audit e il protocollo di gestione restano invariati. Installa i componenti 0.5.7 corrispondenti, ricarica Obsidian, aggiorna il plugin Codex e avvia una nuova attività prima della prova.
