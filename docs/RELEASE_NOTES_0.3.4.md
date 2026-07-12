# Obsidian Bridge 0.3.4 — Obsidian CLI crash hotfix

## English

Version 0.3.4 prevents a known Obsidian 1.12.7 Windows main-process crash caused by large JSON requests sent through the official CLI local IPC channel.

The bridge now:

- caps each complete CLI IPC request at 3072 UTF-8 bytes;
- divides long create and append content on Unicode code-point boundaries;
- rereads and hash-verifies every chunk before sending the next one;
- rechecks permission, stable vault identity, and physical path scope before every mutation;
- recognizes exact intermediate bridge-written states during conservative recovery;
- reports a partial create for manual review instead of deleting it automatically.

The public proposed-content limit remains 8192 UTF-8 bytes. Delete, rename, move, arbitrary overwrite, shell access, plugin management, and `eval` remain unavailable. Existing per-vault permissions and the preview/confirmation workflow are unchanged.

Download **Obsidian-Bridge-Setup-0.3.4.zip**, extract it completely, and run **INSTALLA-OBSIDIAN-BRIDGE.cmd**. Verify the ZIP assets with **SHA256-0.3.4.txt**. Restart Obsidian and start a new Codex task after updating so old bridge processes are no longer active.

## Italiano

La versione 0.3.4 evita un crash noto del processo principale di Obsidian 1.12.7 su Windows, provocato da richieste JSON troppo grandi inviate attraverso il canale IPC locale della CLI ufficiale.

Ora il bridge:

- limita ogni richiesta IPC completa della CLI a 3072 byte UTF-8;
- divide le creazioni e le aggiunte lunghe rispettando i caratteri Unicode;
- rilegge e verifica tramite hash ogni blocco prima di inviare il successivo;
- ricontrolla permesso, identità stabile del vault e percorso fisico prima di ogni modifica;
- riconosce gli stati intermedi esatti prodotti dal bridge durante il recupero prudente;
- segnala una creazione parziale per il controllo manuale invece di cancellarla automaticamente.

Il limite pubblico del testo proposto resta 8192 byte UTF-8. Eliminazione, rinomina, spostamento, sovrascrittura arbitraria, accesso alla shell, gestione dei plugin ed `eval` restano non disponibili. I permessi per vault e il flusso anteprima/conferma non cambiano.

Scarica **Obsidian-Bridge-Setup-0.3.4.zip**, estrailo completamente e avvia **INSTALLA-OBSIDIAN-BRIDGE.cmd**. Verifica gli ZIP con **SHA256-0.3.4.txt**. Dopo l'aggiornamento riavvia Obsidian e apri un nuovo task Codex, così i vecchi processi del bridge non restano attivi.
