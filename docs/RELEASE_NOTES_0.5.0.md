# Obsidian Bridge 0.5.0 — Full management / Gestione completa

[English](#english) · [Italiano](#italiano)

## English

Version 0.5.0 adds real, explicitly authorized management of existing Markdown notes while preserving the safer folder-scoped and create/append workflows.

### Three clear access profiles

- **Protected access**: selected read/write folders; every create or append requires an exact preview and a later explicit confirmation.
- **Autonomous access**: the profile previously labelled Full access. It keeps the stable `accessMode=full` value and permits vault-wide eligible read/create/append without routine per-change questions.
- **Full management**: a new `accessMode=management` profile that includes autonomous access and adds independent **edit**, **move**, and **trash** grants.

An update never enables Full management. Version-2 and version-3 settings migrate with every management grant off. The user must open Bridge Control, review the warning, select the exact non-empty permission set, and acknowledge the named vault.

### New managed operations

- `replace`: replace the complete content of an existing Markdown note;
- `replace_text`: replace an exact literal fragment only when the expected occurrence count matches;
- `frontmatter`: atomically set and remove bounded properties through `Vault.process`, with a before-hash CAS check and Obsidian's public YAML helpers;
- `move`: move or rename one selected note through `Vault.rename`; backlinks and other notes are not rewritten automatically;
- `trash`: send a note through Obsidian's configured trash flow.

Permanent deletion is not available. The bridge also exposes no shell, `eval`, arbitrary Obsidian command, command palette, direct filesystem note write, or plugin management.

### Safety and recovery

Managed work has its own prepare/commit process. Prepare is non-mutating and returns a bounded exact preview. Commit consumes one expiring single-use ID, rechecks the current granular permission, stable vault identity, physical path, source hash, and destination state under shared locks.

The manager invokes only the fixed `bridge-control:commit` custom CLI handler. Bridge Control claims a bounded token-bound request, rechecks authorization inside Obsidian, creates a plaintext recovery backup, applies the operation through the fixed public API surface, verifies the postcondition, and records metadata-only audit state. Frontmatter is transformed with `Vault.process` plus `getFrontMatterInfo`, `parseYaml`, and `stringifyYaml`; move/rename uses `Vault.rename` so the move grant never causes hidden edits to referring notes. Create/append and management share a newest-20 local backup pool, so keep an independent vault backup.

Replace/frontmatter recovery can restore only a known bridge-written state. Move reversal is conflict-aware. Trash is never silently reversed; use Obsidian trash or the backup. Unknown concurrent content is never overwritten.

Bridge Control's **Recent problems** panel and `obsidian_recent_write_events` now understand replacement, frontmatter, move/rename, and trash events, including a move destination, without returning note or backup bodies.

### Install or update

1. Download `Obsidian-Bridge-Setup-0.5.0.zip` and `SHA256-0.5.0.txt` from the GitHub release.
2. Verify the archive checksum and extract it completely.
3. Run `INSTALLA-OBSIDIAN-BRIDGE.cmd`, select the same vault, and complete the update.
4. Restart or reload Obsidian so Bridge Control 0.5.0 registers its handler.
5. Start a new Codex task so the new management MCP process is loaded.
6. Confirm that your existing profile was preserved and that Full management is off.
7. Test with a synthetic note and an independent backup. Enable **Edit** first; add **Move** or **Trash** only in separate tests.

Returning to Autonomous or Protected access, clearing a granular grant, or disabling the bridge revokes management at the next stage.

## Italiano

La versione 0.5.0 aggiunge la gestione reale ed esplicitamente autorizzata delle note Markdown esistenti, mantenendo i flussi più prudenti per cartelle e create/append.

### Tre profili di accesso chiari

- **Accesso protetto**: cartelle di lettura/scrittura selezionate; ogni create o append richiede un'anteprima esatta e una conferma esplicita successiva.
- **Accesso autonomo**: è il profilo chiamato Accesso completo nelle versioni precedenti. Conserva il valore stabile `accessMode=full` e permette lettura/create/append autonomi sui percorsi idonei dell'intero vault.
- **Gestione completa**: nuovo profilo `accessMode=management` che include l'accesso autonomo e aggiunge permessi indipendenti **modifica**, **sposta** e **cestino**.

Un aggiornamento non attiva mai Gestione completa. Le impostazioni versione 2 e 3 migrano con tutti i permessi di gestione disattivati. L'utente deve aprire Bridge Control, leggere l'avviso, scegliere l'insieme esatto e non vuoto dei permessi e confermare il vault indicato.

### Nuove operazioni gestite

- `replace`: sostituzione del contenuto completo di una nota Markdown esistente;
- `replace_text`: sostituzione di un frammento letterale soltanto se coincide il numero di occorrenze atteso;
- `frontmatter`: set/remove atomico di proprietà limitate tramite `Vault.process`, con controllo CAS sull'hash precedente e helper YAML pubblici di Obsidian;
- `move`: spostamento o rinomina di una sola nota tramite `Vault.rename`; backlink e altre note non vengono riscritti automaticamente;
- `trash`: invio della nota al cestino configurato da Obsidian.

La cancellazione permanente non è disponibile. Il bridge non espone inoltre shell, `eval`, comandi Obsidian arbitrari, palette comandi, scrittura diretta dei file delle note o gestione plugin.

### Sicurezza e recupero

La gestione usa un processo prepare/commit dedicato. Prepare non modifica il vault e restituisce un'anteprima esatta e limitata. Commit consuma un ID monouso e in scadenza, poi ricontrolla permesso granulare, identità stabile del vault, percorso fisico, hash sorgente e stato della destinazione sotto lock condivisi.

Il gestore invoca soltanto l'handler CLI fisso `bridge-control:commit`. Bridge Control acquisisce una richiesta limitata e legata a un token, ricontrolla l'autorizzazione dentro Obsidian, crea un backup di recupero in chiaro, applica l'operazione tramite la superficie API pubblica prefissata, verifica il risultato e registra un audit di soli metadati. Il frontmatter viene trasformato con `Vault.process`, `getFrontMatterInfo`, `parseYaml` e `stringifyYaml`; spostamento/rinomina usa `Vault.rename`, così il permesso sposta non provoca modifiche nascoste alle note che fanno riferimento al file. Create/append e gestione condividono un pool locale degli ultimi 20 backup: conserva quindi un backup indipendente del vault.

Il recupero di replace/frontmatter può ripristinare soltanto uno stato noto scritto dal bridge. L'inversione di uno spostamento controlla i conflitti. Il cestino non viene mai annullato silenziosamente: usa il cestino di Obsidian o il backup. Un contenuto concorrente sconosciuto non viene sovrascritto.

Il pannello **Problemi recenti** e `obsidian_recent_write_events` comprendono ora eventi di sostituzione, frontmatter, spostamento/rinomina e cestino, compresa la destinazione di uno spostamento, senza restituire il corpo di note o backup.

### Installazione o aggiornamento

1. Scarica `Obsidian-Bridge-Setup-0.5.0.zip` e `SHA256-0.5.0.txt` dalla release GitHub.
2. Verifica il checksum dell'archivio ed estrailo completamente.
3. Avvia `INSTALLA-OBSIDIAN-BRIDGE.cmd`, seleziona lo stesso vault e completa l'aggiornamento.
4. Riavvia o ricarica Obsidian affinché Bridge Control 0.5.0 registri il proprio handler.
5. Avvia una nuova attività Codex per caricare il nuovo processo MCP di gestione.
6. Controlla che il profilo precedente sia stato conservato e che Gestione completa sia disattivata.
7. Prova con una nota sintetica e un backup indipendente. Abilita prima **Modifica**; aggiungi **Sposta** o **Cestino** soltanto in test separati.

Tornare ad Accesso autonomo o protetto, disattivare un permesso granulare o spegnere il bridge revoca la gestione dalla fase successiva.
