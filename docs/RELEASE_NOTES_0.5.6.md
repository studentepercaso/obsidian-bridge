# Obsidian Bridge 0.5.6 — Stable synchronized reads / Letture sincronizzate stabili

## English

Obsidian Bridge 0.5.6 fixes false `vault document changed while it was being read` conflicts on Windows files managed by OneDrive or another synchronization provider. Windows `ctime` can change for metadata-only activity even when note bytes and `mtime` do not change; it is therefore no longer accepted by itself as proof of a content mutation.

The exact reader now performs up to three bounded positional passes over the same stable file handle. A snapshot is accepted only after two complete byte sequences agree and a final window has stable `ctime` on the handle and vault path. Real concurrency remains fail-closed: identity, path, type/link count, size, `mtime`, truncation, growth, or differing bytes reject the operation. Same-size content changes with a restored `mtime`, including a change after the second read, are covered by regression tests.

No permission, management capability, command-protocol field, network flow, write surface, proposal limit, resulting-note limit, or CLI-frame limit is increased. The limits remain 64 KiB per create/append proposal, 1 MiB for the observed resulting document, and 3072 UTF-8 bytes per Unicode-safe CLI frame.

Install matching 0.5.6 components, reload Obsidian, reinstall or refresh the Codex plugin, and start a new Codex task so no 0.5.5 MCP process remains active. Test first on synthetic data with an independent backup. This release does not claim an automatic retry of a previously failed management change or a live mutation of a production vault.

## Italiano

Obsidian Bridge 0.5.6 corregge i falsi conflitti `vault document changed while it was being read` sui file Windows gestiti da OneDrive o da un altro servizio di sincronizzazione. Su Windows `ctime` può cambiare per sole attività sui metadati anche quando i byte della nota e `mtime` non cambiano; non viene quindi più considerato, da solo, una prova di modifica del contenuto.

Il lettore esatto esegue ora fino a tre passate posizionali limitate sullo stesso handle stabile. Uno snapshot viene accettato soltanto dopo due sequenze complete di byte identiche e una finestra finale con `ctime` stabile sull'handle e sul percorso del vault. Le vere modifiche concorrenti restano bloccate: cambi di identità, percorso, tipo o numero di link, dimensione, `mtime` o byte, troncamenti e crescite respingono l'operazione. I test coprono anche modifiche della stessa dimensione con `mtime` ripristinato, comprese quelle successive alla seconda lettura.

Non aumentano permessi, capacità di gestione, campi del protocollo dei comandi, flussi di rete, superfici di scrittura, limite della proposta, limite della nota risultante o limite dei frame CLI. I limiti restano 64 KiB per proposta create/append, 1 MiB per il documento risultante osservato e 3072 byte UTF-8 per ogni frame CLI sicuro rispetto a Unicode.

Installa i componenti 0.5.6 corrispondenti, ricarica Obsidian, reinstalla o aggiorna il plugin Codex e avvia una nuova attività Codex, così nessun processo MCP 0.5.5 resta attivo. Prova prima con dati sintetici e un backup indipendente. Questa release non dichiara un retry automatico di una modifica gestita già fallita né una mutazione live di un vault di produzione.
