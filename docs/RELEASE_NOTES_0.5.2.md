# Obsidian Bridge 0.5.2 — Exact management snapshots / Snapshot di gestione esatti

## English

Obsidian Bridge 0.5.2 fixes a repeatable false `CHANGE_CONFLICT` in Full-management operations on notes without a final newline.

### What happened

The management preview previously derived its source hash from the official Obsidian CLI read result. For a note whose last byte was not a newline, that read path could return the same text with a terminal newline added. Bridge Control later compared the prepared hash with the exact content returned inside Obsidian, so the two representations never matched even when no user, Sync client, plugin, or watcher had changed the note. The operation failed closed before mutation; a subsequent independent reread confirmed that the note itself was unchanged. The failed audit record's before/after hash fields are not used as proof of that state.

### What changed

- Managed preparation now derives its compare-and-swap state from a bounded exact UTF-8 source snapshot instead of CLI-normalized read output.
- A note without a final newline can therefore be replaced, edited literally, updated in frontmatter, moved, or trashed without a false conflict caused only by representation normalization.
- LF, CRLF, terminal-newline, and UTF-8 BOM distinctions remain part of the prepared source state.
- Bridge Control still compares the exact in-Obsidian source with the prepared hash immediately before mutation. A real edit between prepare and commit still returns `CHANGE_CONFLICT` and leaves the note untouched.

### Security and compatibility

This is a conflict-detection patch, not an access expansion. It adds no permission, MCP tool, companion command, management request field, settings migration, audit field, or direct note-write path. The version-4 shared-settings schema, `bridge-control:commit` protocol, granular edit/move/trash grants, recovery backups, metadata-only audit, and public Obsidian API mutation surface are unchanged.

The exact snapshot is read only for an already authorized, eligible managed source, remains subject to vault identity, physical containment, hidden-path, size, and UTF-8 checks, and is not stored as a new persistent copy. Mutations continue to run only through Bridge Control's authenticated one-time handler and public Obsidian APIs.

### Updating and testing

Install matching Obsidian Bridge and Bridge Control 0.5.2 components, reload Obsidian, refresh or reinstall the Codex plugin, and start a new Codex task. Existing settings and permissions are preserved.

Use a disposable synthetic note for the first test. Test a note without a final newline, then separate LF, CRLF, and BOM fixtures. Also prepare a change and deliberately edit the note before commit to confirm that a genuine concurrent change is still rejected. Do not automatically retry an earlier failed change ID; prepare a new change only after rereading the note and receiving explicit user direction.

## Italiano

Obsidian Bridge 0.5.2 corregge un falso `CHANGE_CONFLICT` riproducibile nelle operazioni di Gestione completa su note prive di nuova riga finale.

### Che cosa accadeva

L'anteprima di gestione ricavava in precedenza l'hash sorgente dal risultato di lettura della CLI ufficiale di Obsidian. Per una nota il cui ultimo byte non era una nuova riga, quel percorso poteva restituire lo stesso testo con una nuova riga aggiunta in fondo. Bridge Control confrontava poi l'hash preparato con il contenuto esatto restituito dentro Obsidian: le due rappresentazioni non coincidevano mai, anche quando nessun utente, client Sync, plugin o watcher aveva modificato la nota. L'operazione si chiudeva in modo prudente prima della modifica; una rilettura indipendente successiva confermava che la nota era rimasta invariata. I campi hash prima/dopo del record audit fallito non vengono usati come prova di quello stato.

### Che cosa cambia

- La preparazione gestita ricava ora lo stato compare-and-swap da uno snapshot UTF-8 esatto e limitato della sorgente, non dall'output di lettura normalizzato dalla CLI.
- Una nota senza nuova riga finale può quindi essere sostituita, modificata letteralmente, aggiornata nel frontmatter, spostata o cestinata senza un falso conflitto dovuto soltanto alla normalizzazione della rappresentazione.
- Le differenze tra LF, CRLF, nuova riga finale e BOM UTF-8 restano parte dello stato sorgente preparato.
- Bridge Control continua a confrontare il contenuto esatto visto dentro Obsidian con l'hash preparato subito prima della modifica. Una vera modifica tra prepare e commit restituisce ancora `CHANGE_CONFLICT` e lascia la nota intatta.

### Sicurezza e compatibilità

Questa è una patch del rilevamento dei conflitti, non un ampliamento dell'accesso. Non aggiunge permessi, strumenti MCP, comandi companion, campi nelle richieste di gestione, migrazioni delle impostazioni, campi audit o percorsi di scrittura diretta delle note. Restano invariati lo schema condiviso versione 4, il protocollo `bridge-control:commit`, i permessi granulari edit/move/trash, i backup di recupero, l'audit composto soltanto da metadati e la superficie di modifica tramite API pubbliche di Obsidian.

Lo snapshot esatto viene letto soltanto per una sorgente gestita già autorizzata e idonea, continua a rispettare i controlli su identità del vault, contenimento fisico, percorsi nascosti, dimensione e UTF-8 e non viene salvato come nuova copia persistente. Le modifiche continuano a passare esclusivamente dall'handler autenticato monouso di Bridge Control e dalle API pubbliche di Obsidian.

### Aggiornamento e prova

Installa i componenti Obsidian Bridge e Bridge Control 0.5.2 corrispondenti, ricarica Obsidian, aggiorna o reinstalla il plugin Codex e avvia una nuova attività Codex. Impostazioni e permessi esistenti vengono conservati.

Per la prima prova usa una nota sintetica in un ambiente non produttivo. Prova una nota senza nuova riga finale, poi fixture separate con LF, CRLF e BOM. Prepara inoltre una modifica e cambia deliberatamente la nota prima del commit per verificare che una vera concorrenza venga ancora respinta. Non riprovare automaticamente un vecchio `change_id` fallito: prepara una nuova modifica soltanto dopo aver riletto la nota e ricevuto un'indicazione esplicita dell'utente.
