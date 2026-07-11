# Obsidian Bridge 0.3.3 — Security update

## English

Version 0.3.3 updates the bundled Bridge Control companion and publishes its canonical standalone repository for Obsidian Community Plugins review.

Security and reliability changes:

- Vault plugin data can no longer redirect the external shared settings file.
- The guided installer no longer persists that external destination in `data.json`.
- Obsidian's global vault registry is read through a regular-file, no-symlink and fixed 1 MiB boundary.
- CLI diagnostics run only after an explicit click, never search the ambient `PATH`, execute only `version` without a shell, and require recognized Obsidian version output.
- CI now runs the expanded companion test suite and rejects stale generated bundles.

Existing per-vault permissions are preserved during update. New vaults remain deny-by-default, writing remains disabled until explicitly enabled for selected folders, and every create or append still requires preview and separate confirmation.

Download **Obsidian-Bridge-Setup-0.3.3.zip**, extract it completely, and run **INSTALLA-OBSIDIAN-BRIDGE.cmd**. Verify the two ZIP assets with **SHA256-0.3.3.txt**. Use a disposable vault or synthetic folder first and keep an independent backup.

The standalone companion source is available at:
https://github.com/studentepercaso/bridge-control

## Italiano

La versione 0.3.3 aggiorna il companion Bridge Control incluso e pubblica il suo repository autonomo canonico, pronto per la revisione dei Community Plugin di Obsidian.

Modifiche di sicurezza e affidabilità:

- I dati del plugin nel vault non possono più reindirizzare il file esterno delle impostazioni condivise.
- L'installer guidato non salva più quella destinazione esterna in `data.json`.
- Il registro globale dei vault Obsidian viene letto con controlli su file regolare, collegamenti simbolici e un limite fisso di 1 MiB.
- La diagnostica CLI parte soltanto dopo un clic esplicito, non cerca mai nel `PATH` generale, esegue soltanto `version` senza shell e richiede un formato versione Obsidian riconosciuto.
- La CI esegue la suite ampliata del companion e rifiuta bundle generati non aggiornati.

I permessi esistenti per vault vengono conservati durante l'aggiornamento. I nuovi vault restano senza accesso iniziale, la scrittura resta disattivata finché non viene abilitata per cartelle selezionate e ogni creazione o aggiunta richiede ancora anteprima e conferma separata.

Scarica **Obsidian-Bridge-Setup-0.3.3.zip**, estrailo completamente e avvia **INSTALLA-OBSIDIAN-BRIDGE.cmd**. Verifica i due ZIP con **SHA256-0.3.3.txt**. Inizia con un vault usa-e-getta o una cartella sintetica e conserva un backup indipendente.

Il sorgente autonomo del companion è disponibile qui:
https://github.com/studentepercaso/bridge-control
