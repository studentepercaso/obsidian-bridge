# Obsidian Bridge 0.5.8 — Adaptive Windows installer / Installer Windows adattivo

## English

Obsidian Bridge 0.5.8 redesigns the guided Windows setup as an adaptive WPF interface. Automatic rows, wrapping, and vertical scrolling prevent long vault paths, instructions, consent text, status messages, and errors from overlapping or hiding the next action. The layout remains usable in a compact window and with high Windows display scaling.

The release package now exercises the real WPF window in an isolated STA smoke mode. The check verifies that the header, main scroll area, and completion actions are reachable, closes automatically, and does not attempt to install or alter user settings.

The self-contained Codex payload introduced in 0.5.7 is unchanged. This release adds no permission, protocol, write-limit, audit, backup, or note-mutation change. Install matching 0.5.8 components, reload Obsidian, refresh the Codex plugin, and start a new task before testing.

## Italiano

Obsidian Bridge 0.5.8 ridisegna l’installazione guidata per Windows con un’interfaccia WPF adattiva. Righe automatiche, testo a capo e scorrimento verticale impediscono a percorsi del vault, istruzioni, consenso, messaggi di stato ed errori lunghi di sovrapporsi o nascondere l’azione successiva. Il layout resta utilizzabile in una finestra compatta e con un ridimensionamento elevato dello schermo di Windows.

Il pacchetto di rilascio ora prova la vera finestra WPF in una modalità smoke STA isolata. Il controllo verifica che intestazione, area principale scorrevole e azioni finali siano raggiungibili, si chiude automaticamente e non tenta installazioni né modifica le impostazioni dell’utente.

Il payload Codex autosufficiente introdotto nella 0.5.7 resta invariato. Questa release non modifica permessi, protocollo, limiti di scrittura, audit, backup o semantica delle modifiche alle note. Installa i componenti 0.5.8 corrispondenti, ricarica Obsidian, aggiorna il plugin Codex e avvia una nuova attività prima della prova.
