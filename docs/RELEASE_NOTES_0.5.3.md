# Obsidian Bridge 0.5.3 — Exact writer observations / Osservazioni esatte del writer

## English

Obsidian Bridge 0.5.3 fixes the remaining representation mismatch in protected and autonomous `create`/`append` transactions. Version 0.5.2 made Full-management source snapshots exact, but the create/append writer still obtained some source and verification observations from normalized Obsidian CLI stdout. A note without a final newline could therefore be written correctly and then fail post-write verification.

For vaults authorized through Bridge Control shared settings, every create/append transactional observation now comes from the same bounded, read-only, exact UTF-8 snapshot path:

- preparation and the prepared before-hash;
- the commit compare-and-swap check;
- append backup capture;
- intermediate chunk checks and final verification;
- the observation used to classify recovery or manual intervention after failure.

The snapshot preserves the exact decoded UTF-8 representation, including no-final-newline, LF/CRLF, BOM, and Unicode distinctions. It is read-only, settings-backed, physically scoped to the authorized vault, bounded to 1 MiB, and fails closed on invalid UTF-8, redirected paths, identity changes, or concurrent reads. It does **not** write note data. All create/append mutation remains on the existing allowlisted official Obsidian CLI commands.

The legacy environment-only writer now fails closed for create/append and directs the user to migrate the vault to Bridge Control. CLI stdout can normalize content and is not an exact compare-and-swap source. Environment variables still cannot activate Autonomous access or Full management.

Additional pre-mutation guards reject append when the exact resulting document would exceed 1 MiB and reject create when the destination parent folder does not already exist. The bridge does not create parent folders implicitly.

### Recovery behavior

Version 0.5.3 no longer performs an automatic destructive create/append rollback through the CLI. A CLI compare-and-restore sequence is not atomic with respect to Obsidian, sync clients, editors, or other plugins and could overwrite a concurrent change. If an append has mutated the note but writing or verification fails, the bridge keeps the exact plaintext backup and metadata-only audit evidence, leaves the observed note untouched, and reports `manual_recovery_required=true`. The safe bounded cause is `WRITE_FAILED_MANUAL_RECOVERY_REQUIRED` or `VERIFICATION_FAILED_MANUAL_RECOVERY_REQUIRED`. A partial create remains `delete_disabled`, because permanent deletion is not exposed.

This is deliberately not a claim of atomic rollback. A future automatic restore would require an atomic Bridge Control transaction. After either manual-recovery result, inspect the current note, backup, and audit evidence and obtain explicit user direction; do not retry automatically.

Bridge Control 0.5.3 updates release metadata, documentation, and its read-only audit diagnostics so Recent problems accepts and classifies the two new bounded manual-recovery codes. Its command protocol, settings schema, permission model, management handler, and public Obsidian API mutation code are unchanged. This release adds no permission, tool, arbitrary command, direct filesystem note mutation, shell, `eval`, or permanent-delete surface.

Install matching Obsidian Bridge and Bridge Control 0.5.3 components, reload Obsidian, refresh or reinstall the Codex plugin, and start a new Codex task. Automated regression coverage must pass before publication; these notes do not claim that a live-vault smoke test has passed.

## Italiano

Obsidian Bridge 0.5.3 corregge la restante differenza di rappresentazione nelle transazioni `create`/`append` protette e autonome. La versione 0.5.2 aveva reso esatti gli snapshot della Gestione completa, ma il writer create/append ricavava ancora alcune osservazioni della sorgente e della verifica dallo stdout normalizzato della CLI di Obsidian. Una nota priva di nuova riga finale poteva quindi essere scritta correttamente e fallire subito dopo nella verifica.

Per i vault autorizzati tramite le impostazioni condivise di Bridge Control, ogni osservazione transazionale create/append usa ora lo stesso percorso di snapshot UTF-8 esatto, limitato e di sola lettura:

- preparazione e hash iniziale preparato;
- controllo compare-and-swap al commit;
- acquisizione del backup prima di append;
- controlli dei blocchi intermedi e verifica finale;
- osservazione usata per classificare recupero o intervento manuale dopo un errore.

Lo snapshot conserva la rappresentazione UTF-8 decodificata esatta, comprese assenza della nuova riga finale, LF/CRLF, BOM e differenze Unicode. È di sola lettura, deriva dalle impostazioni, resta fisicamente confinato al vault autorizzato, è limitato a 1 MiB e si chiude in modo prudente su UTF-8 non valido, percorsi reindirizzati, cambi d'identità o letture concorrenti. **Non** scrive dati nelle note. Tutte le mutazioni create/append continuano a passare esclusivamente dai comandi allowlistati della CLI ufficiale di Obsidian.

Il writer legacy configurato soltanto tramite variabili d'ambiente ora rifiuta create/append e richiede la migrazione del vault a Bridge Control. Lo stdout della CLI può normalizzare il contenuto e non costituisce una sorgente compare-and-swap esatta. Le variabili d'ambiente continuano a non poter attivare Accesso autonomo o Gestione completa.

Nuovi controlli prima della mutazione rifiutano append quando il documento risultante esatto supererebbe 1 MiB e create quando la cartella padre della destinazione non esiste già. Il bridge non crea implicitamente cartelle padre.

### Comportamento di recupero

La versione 0.5.3 non esegue più rollback create/append automatici e distruttivi tramite CLI. Una sequenza CLI di confronto e ripristino non è atomica rispetto a Obsidian, client di sincronizzazione, editor o altri plugin e potrebbe sovrascrivere una modifica concorrente. Se append ha già modificato la nota ma la scrittura o la verifica fallisce, il bridge conserva il backup esatto in chiaro e l'evidenza audit composta solo da metadati, lascia intatta la nota osservata e restituisce `manual_recovery_required=true`. La causa limitata e sicura è `WRITE_FAILED_MANUAL_RECOVERY_REQUIRED` oppure `VERIFICATION_FAILED_MANUAL_RECOVERY_REQUIRED`. Una creazione parziale resta `delete_disabled`, perché la cancellazione permanente non è esposta.

Questa non è una promessa di rollback atomico. Un futuro ripristino automatico richiederebbe una transazione atomica dentro Bridge Control. Dopo un risultato che richiede recupero manuale, controlla nota corrente, backup ed evidenza audit e attendi indicazioni esplicite dell'utente; non riprovare automaticamente.

Bridge Control 0.5.3 aggiorna metadati di release, documentazione e diagnostica audit di sola lettura affinché Problemi recenti accetti e classifichi i due nuovi codici limitati di recupero manuale. Protocollo dei comandi, schema delle impostazioni, modello dei permessi, handler di gestione e codice di mutazione tramite API pubbliche di Obsidian restano invariati. La release non aggiunge permessi, strumenti, comandi arbitrari, scrittura diretta delle note via filesystem, shell, `eval` o cancellazione permanente.

Installa i componenti Obsidian Bridge e Bridge Control 0.5.3 corrispondenti, ricarica Obsidian, aggiorna o reinstalla il plugin Codex e avvia una nuova attività Codex. Prima della pubblicazione devono superare i test automatici di regressione; queste note non dichiarano superato un test live sul vault.
