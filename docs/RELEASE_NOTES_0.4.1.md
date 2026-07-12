# Obsidian Bridge 0.4.1 — Bridge Control hotfix

## English

Version 0.4.1 fixes a Bridge Control settings-panel crash that could appear immediately after Full access was successfully enabled. The saved permission was already valid; only the panel rerender failed because two CSS class names were passed to the DOM as one token.

The hotfix passes each class as an individual token and adds a regression test. It also reports a later panel-refresh problem separately from a real permission-save failure. Existing version-3 permissions, including an explicitly enabled Full-access profile, remain unchanged.

Download **Obsidian-Bridge-Setup-0.4.1.zip**, extract it completely, and run **INSTALLA-OBSIDIAN-BRIDGE.cmd**. Restart Obsidian after updating.

## Italiano

La versione 0.4.1 corregge un arresto del pannello impostazioni di Bridge Control che poteva comparire subito dopo l'attivazione riuscita di Accesso completo. Il permesso salvato era già valido; falliva soltanto il nuovo rendering del pannello perché due classi CSS venivano inviate al DOM come un unico token.

La correzione passa ogni classe come token separato e aggiunge un test di regressione. Inoltre distingue un successivo problema grafico da un vero errore di salvataggio del permesso. I permessi versione 3 esistenti, incluso un profilo Accesso completo attivato esplicitamente, restano invariati.

Scarica **Obsidian-Bridge-Setup-0.4.1.zip**, estrailo completamente e avvia **INSTALLA-OBSIDIAN-BRIDGE.cmd**. Dopo l'aggiornamento riavvia Obsidian.
