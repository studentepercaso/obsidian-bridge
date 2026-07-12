# Obsidian Bridge 0.4.0 — Full access and visible recovery

## English

Version 0.4.0 adds a simple, explicit **Full access** profile for users who want Codex to work autonomously with an authorized Obsidian vault.

In Bridge Control you can now choose:

- **Protected access**: existing read/write folder choices and confirmation for each change;
- **Full access**: read, create, and append across eligible visible Markdown notes in that vault without a routine confirmation question.

Full access requires one warning acknowledgement naming the current vault. You can return to protected access immediately, and the previous folder choices are preserved. Full access does not enable delete, rename, move, arbitrary overwrite, shell access, plugin management, or `eval`; hidden paths, `.obsidian`, `.trash`, deny prefixes, and physical redirects outside the vault remain blocked.

The release also adds:

- a separate auto-approved writer that refuses every vault not currently set to full access;
- cross-process per-note commit locks shared with the protected writer;
- immediate policy rechecks before commit and every CLI chunk;
- automatic pause after three consecutive autonomous failures in one task;
- a **Recent problems** panel that reads bounded audit metadata, explains recovery, and shows whether the affected note currently exists;
- a read-only `obsidian_recent_write_events` tool so Codex can inspect bounded, currently permitted audit metadata before autonomous work and after an error, without asking for a screenshot;
- atomic full-access activation checked against the latest shared policy under lock; failed increases restore the previous policy, while failed revocations reassert the narrower target or quarantine the file instead of restoring autonomy;
- independent retention of recent failures, serialized panel-data updates, and one deterministic default audit location shared by Codex and Obsidian;
- structured authorization and rollback metadata in the local audit;
- the long-content CLI crash protection introduced in 0.3.4.

Existing version-2 permissions migrate to version 3 as protected access only. No update silently enables autonomy.

Download **Obsidian-Bridge-Setup-0.4.0.zip**, extract it completely, and run **INSTALLA-OBSIDIAN-BRIDGE.cmd**. Restart Obsidian and start a new Codex task after updating so the new autonomous MCP process is loaded.

## Italiano

La versione 0.4.0 aggiunge un profilo semplice ed esplicito **Accesso completo** per chi vuole consentire a Codex di lavorare in autonomia con un vault Obsidian autorizzato.

In Bridge Control ora puoi scegliere:

- **Accesso protetto**: le cartelle di lettura/scrittura già selezionate e una conferma per ogni modifica;
- **Accesso completo**: lettura, creazione e aggiunta nelle note Markdown visibili e idonee dell'intero vault, senza una domanda di conferma di routine.

L'accesso completo richiede un solo avviso con conferma che indica il vault corrente. Puoi tornare immediatamente all'accesso protetto e le vecchie cartelle restano memorizzate. L'accesso completo non abilita eliminazione, rinomina, spostamento, sovrascrittura arbitraria, shell, gestione plugin o `eval`; percorsi nascosti, `.obsidian`, `.trash`, prefissi negati e collegamenti fisici fuori dal vault restano bloccati.

La versione aggiunge inoltre:

- uno scrittore autonomo separato e auto-approvato che rifiuta ogni vault non impostato in accesso completo;
- lock di commit per nota condivisi tra processi autonomi e protetti;
- ricontrollo immediato dei permessi prima del commit e di ogni blocco CLI;
- sospensione automatica dopo tre errori autonomi consecutivi nello stesso task;
- il pannello **Problemi recenti**, che legge metadati audit limitati, spiega il recupero e mostra se la nota interessata esiste attualmente;
- lo strumento di sola lettura `obsidian_recent_write_events`, con cui Codex controlla metadati audit limitati e attualmente autorizzati prima del lavoro autonomo e dopo un errore, senza chiedere screenshot;
- attivazione atomica dell'accesso completo verificata sulla configurazione condivisa più recente sotto lock; gli aumenti falliti ripristinano la policy precedente, mentre una revoca fallita riconferma la policy più stretta o mette il file in quarantena senza ripristinare l'autonomia;
- conservazione indipendente degli errori recenti, salvataggi serializzati del pannello e una cartella audit predefinita deterministica condivisa da Codex e Obsidian;
- modalità di autorizzazione ed esito del rollback registrati nell'audit locale;
- la protezione dai crash CLI per testi lunghi introdotta nella 0.3.4.

I permessi esistenti in versione 2 migrano alla versione 3 soltanto come accesso protetto. Nessun aggiornamento abilita l'autonomia in silenzio.

Scarica **Obsidian-Bridge-Setup-0.4.0.zip**, estrailo completamente e avvia **INSTALLA-OBSIDIAN-BRIDGE.cmd**. Dopo l'aggiornamento riavvia Obsidian e apri un nuovo task Codex, così viene caricato il nuovo processo MCP autonomo.
