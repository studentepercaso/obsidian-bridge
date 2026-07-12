# Obsidian Bridge 0.5.1 — Structured write diagnostics / Diagnostica strutturata delle scritture

## English

Obsidian Bridge 0.5.1 is a focused diagnostic patch. It fixes the loss of the underlying failure category when a create or append commit returned only the generic `write_failed` result.

### What changes

Failed write audit records may now include two optional, bounded fields:

- `failure_stage`, identifying the guarded phase that failed, such as pre-write checks, the write call, post-write verification, or commit-lock handling;
- `cause_code`, a short uppercase machine-readable category derived from a known bridge or Obsidian CLI error.

The same fields are returned by `obsidian_recent_write_events` after the current vault and folder read permissions are rechecked. Bridge Control 0.5.1 understands the matching metadata in **Recent problems**. This lets Codex or another compatible local MCP host explain which stage failed without asking the user to transcribe a dialog or screenshot.

### Privacy boundary

These diagnostics remain metadata-only. The bridge does not place raw exception messages, Obsidian CLI stdout or stderr, note text, proposed content, or backup bodies in the audit fields or the read-only diagnostic result. Values are size-bounded and schema-validated. Paths, change IDs, backup IDs, and diagnostic codes can still be sensitive local metadata.

### Recovery and retries

Existing rollback fields remain authoritative evidence about the recovery attempt. For example, `rollback_succeeded=true` with `rollback_reason=unchanged` means the observed note still matched its prepared pre-write state; it does not mean the failed write should be repeated automatically.

`failure_stage` and `cause_code` are evidence only. They cannot activate a permission, confirm a protected write, authorize a retry, waive a conflict, or prove the current note state. After a failure, the agent must read the bounded audit event, reread the affected source and destination where applicable, report the observed state, and stop for human direction.

### Updating

Install matching Obsidian Bridge and Bridge Control 0.5.1 components, reload Obsidian, reinstall or refresh the Codex plugin, and start a new Codex task so the updated MCP definitions and skill instructions are loaded. Existing settings and granular management permissions are preserved; this patch grants no new access.

Update and reload Bridge Control before testing the new writer. Bridge Control 0.5.0 intentionally rejected unknown audit keys, so during a staggered update it can temporarily count a new 0.5.1 diagnostic record as malformed until the companion is also updated.

## Italiano

Obsidian Bridge 0.5.1 è una patch mirata alla diagnostica. Corregge la perdita della categoria tecnica originaria quando il commit di una creazione o aggiunta restituiva soltanto il risultato generico `write_failed`.

### Cosa cambia

I record audit delle scritture fallite possono ora includere due campi opzionali e limitati:

- `failure_stage`, che indica la fase protetta in cui si è verificato l'errore, per esempio controlli preliminari, chiamata di scrittura, verifica successiva o gestione del lock di commit;
- `cause_code`, una breve categoria maiuscola e leggibile dalla macchina derivata da un errore noto del bridge o della CLI di Obsidian.

Gli stessi campi vengono restituiti da `obsidian_recent_write_events` dopo aver ricontrollato i permessi correnti di lettura per vault e cartella. Bridge Control 0.5.1 comprende i metadati corrispondenti in **Problemi recenti**. Codex o un altro host MCP locale compatibile può quindi spiegare in quale fase si è verificato il problema senza chiedere all'utente di trascrivere finestre o screenshot.

### Confine di privacy

La diagnostica resta composta esclusivamente da metadati. Il bridge non inserisce nei campi audit o nel risultato diagnostico di sola lettura messaggi grezzi delle eccezioni, stdout o stderr della CLI di Obsidian, testo delle note, contenuto proposto o corpo dei backup. I valori sono limitati in dimensione e validati dallo schema. Percorsi, ID modifica, ID backup e codici diagnostici restano comunque metadati locali potenzialmente sensibili.

### Recupero e nuovi tentativi

I campi di rollback esistenti restano l'evidenza autorevole sul tentativo di recupero. Per esempio, `rollback_succeeded=true` con `rollback_reason=unchanged` indica che la nota osservata corrispondeva ancora allo stato precedente preparato; non significa che la scrittura fallita debba essere ripetuta automaticamente.

`failure_stage` e `cause_code` sono soltanto evidenza. Non possono attivare un permesso, confermare una scrittura protetta, autorizzare un nuovo tentativo, ignorare un conflitto o dimostrare lo stato attuale della nota. Dopo un errore, l'agente deve leggere l'evento audit limitato, rileggere sorgente e destinazione interessate quando necessario, descrivere lo stato osservato e fermarsi in attesa di indicazioni umane.

### Aggiornamento

Installa i componenti Obsidian Bridge e Bridge Control 0.5.1 corrispondenti, ricarica Obsidian, reinstalla o aggiorna il plugin Codex e avvia una nuova attività Codex affinché vengano caricate le definizioni MCP e le istruzioni aggiornate. Le impostazioni esistenti e i permessi granulari di gestione vengono conservati; questa patch non concede nuovi accessi.

Aggiorna e ricarica Bridge Control prima di provare il nuovo writer. Bridge Control 0.5.0 rifiutava intenzionalmente le chiavi audit sconosciute: durante un aggiornamento sfalsato può quindi contare temporaneamente un nuovo record diagnostico 0.5.1 come non valido, finché anche il companion non viene aggiornato.
