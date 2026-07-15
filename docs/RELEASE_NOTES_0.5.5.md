# Obsidian Bridge 0.5.5 — Larger bounded writes / Scritture limitate più ampie

## English

Obsidian Bridge 0.5.5 raises the maximum proposed content for one protected or autonomous `create`/`append` transaction from **8 KiB to 64 KiB** (65,536 UTF-8 bytes). This removes the practical 8 KiB bottleneck when creating a substantial note or appending a larger structured section.

The safety boundaries remain layered and separate:

- the resulting Markdown document must stay at or below **1 MiB**;
- every official Obsidian CLI IPC frame remains at or below **3,072 UTF-8 bytes**;
- large proposals are split only on Unicode code-point boundaries and each intermediate state is read back and hash-verified;
- the exact preview budget is **192 KiB**, large enough to display valid newline-dense 64 KiB proposals without truncation;
- protected access still requires a later explicit confirmation, while Autonomous access and Full management retain their existing authorization rules.

Automated tests cover the exact 65,536-byte ASCII and multibyte boundaries, rejection at 65,537 bytes, large create and append commits, newline-dense previews, the unchanged 1 MiB document cap, and the unchanged 3,072-byte IPC frame cap. This release adds no permission, network request, direct filesystem note-write path, permanent deletion, arbitrary command, shell, or `eval` surface.

Install matching 0.5.5 components, reload Obsidian, refresh or reinstall the Codex plugin, and start a new Codex task so older MCP processes do not retain the previous schema.

## Italiano

Obsidian Bridge 0.5.5 aumenta il contenuto massimo proposto da una singola transazione protetta o autonoma `create`/`append` da **8 KiB a 64 KiB** (65.536 byte UTF-8). Viene così eliminato il limite pratico di 8 KiB quando si crea una nota consistente o si aggiunge una sezione strutturata più ampia.

Le protezioni restano separate e stratificate:

- il documento Markdown risultante deve restare entro **1 MiB**;
- ogni frame IPC della CLI ufficiale di Obsidian resta entro **3.072 byte UTF-8**;
- le proposte ampie vengono suddivise soltanto ai confini dei code point Unicode e ogni stato intermedio viene riletto e verificato tramite hash;
- il limite dell'anteprima esatta sale a **192 KiB**, sufficiente a mostrare senza tagli anche proposte valide da 64 KiB con moltissime nuove righe;
- l'Accesso protetto richiede ancora una conferma esplicita successiva, mentre Accesso autonomo e Gestione completa conservano le regole di autorizzazione esistenti.

I test automatici coprono il confine esatto di 65.536 byte ASCII e multibyte, il rifiuto a 65.537 byte, commit create e append ampi, anteprime dense di nuove righe, il limite invariato di 1 MiB per il documento e il limite invariato di 3.072 byte per frame IPC. Questa release non aggiunge permessi, richieste di rete, scrittura diretta delle note via filesystem, cancellazione permanente, comandi arbitrari, shell o `eval`.

Installa i componenti 0.5.5 corrispondenti, ricarica Obsidian, aggiorna o reinstalla il plugin Codex e avvia una nuova attività Codex, così i vecchi processi MCP non conservano lo schema precedente.
