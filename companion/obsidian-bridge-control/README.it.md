# Bridge Control

[English](README.md) · [Italiano](README.it.md)

Bridge Control è il companion desktop di Obsidian Bridge. La versione 0.5.7 si coordina con la correzione del bridge per i falsi conflitti di lettura su OneDrive e altri file Windows sincronizzati, conservando il companion rafforzato per la revisione, i profili espliciti **Gestione completa**, Accesso protetto e Accesso autonomo e gli stessi confini dei permessi.

## Comportamento iniziale

Al primo avvio:

- l'accesso è associato all'ID stabile e al percorso locale del vault corrente;
- la lettura resta disattivata finché l'utente non seleziona cartelle o l'intero vault idoneo;
- la scrittura e tutti i permessi di gestione sono disattivati;
- il profilo iniziale è **Accesso protetto**;
- nessuna cartella è preimpostata e nessun aggiornamento aumenta i permessi in silenzio.

Il pannello include un selettore visuale ricercabile, checkbox separate **Leggi** e **Scrivi**, controlli verificati per la modalità di accesso, diagnostica non esecutiva dei candidati CLI di Obsidian e una vista **Problemi recenti**. Il selettore usa il vero `Vault.configDir` del vault invece di presumere che la cartella di configurazione si chiami `.obsidian`.

## Profili di accesso

- **Accesso protetto** limita lettura, creazione e aggiunta controllata alle cartelle scelte dall'utente. Ogni scrittura protetta richiede ancora anteprima e conferma esplicita.
- **Accesso autonomo** consente lettura, creazione e aggiunta nell'intero vault idoneo senza conferma per ogni modifica. Non autorizza sostituzioni in-place, modifica del frontmatter, rinomina, spostamento o cestino.
- **Gestione completa** è un profilo separato che richiede una conferma esplicita. L'utente sceglie le singole capacità: **Modifica note e frontmatter**, **Rinomina e sposta** e **Sposta nel cestino di Obsidian**.

Gestione completa vale soltanto finché il profilo e il permesso specifico restano attivi. Bridge Control ricontrolla le impostazioni condivise autorevoli subito prima della modifica. Il ritorno ad Accesso protetto o Accesso autonomo disattiva tutti i permessi di gestione.

## Operazioni gestite

Obsidian Bridge prepara un'anteprima limitata e una richiesta monouso con scadenza breve. Bridge Control consuma la richiesta tramite l'handler pubblico della CLI di Obsidian `bridge-control:commit`, autentica ID opaco e token, ricontrolla vault, permesso, percorso, scadenza e hash iniziale, quindi esegue l'operazione dentro Obsidian con API pubbliche:

- `Vault.process()` per la sostituzione atomica del contenuto di una nota;
- `Vault.process()` con gli helper YAML pubblici di Obsidian per modificare il frontmatter in modo atomico e controllato dall'hash;
- `Vault.rename()` per rinomina e spostamento senza riscrivere silenziosamente altre note o trasformare il permesso Sposta in Modifica;
- `FileManager.trashFile()` per una cancellazione recuperabile.

Il bridge 0.5.7 corrispondente verifica le note sincronizzate con letture ripetute e identiche byte per byte e una finestra limitata di stabilità dei metadati. Le sole variazioni di `ctime` possono stabilizzarsi senza diventare falsi conflitti di contenuto, mentre cambi di identità, dimensione, `mtime`, percorso o byte, troncamenti e crescite continuano a essere respinti. Il percorso di snapshot resta di sola lettura; le mutazioni create/append restano sulla CLI ufficiale allowlistata. Ogni proposta create/append accetta al massimo 64 KiB di contenuto UTF-8, la relativa anteprima completa è limitata a 192 KiB e i contenuti lunghi restano suddivisi in frame CLI completi di non più di 3072 byte UTF-8. Create/append configurati soltanto tramite ambiente richiedono la migrazione a Bridge Control, il documento risultante dopo append resta limitato a 1 MiB e create richiede una cartella padre esistente. La versione 0.5.7 non cambia né il protocollo dei comandi né il codice di mutazione gestita.

Prima della modifica, l'handler salva un backup locale di recupero. Poi verifica il risultato, registra i metadati nell'audit condiviso e tenta un rollback limitato se un'operazione applicata solo in parte non raggiunge la condizione attesa. Le richieste sono serializzate e consumate una sola volta.

Il writer esterno create/append non tenta rollback CLI automatici e distruttivi dopo un errore successivo alla mutazione. Conserva backup esatto ed evidenza audit, lascia intatta la nota osservata e restituisce `manual_recovery_required=true`; una create parziale resta `delete_disabled`. Non è una promessa di rollback atomico e non modifica l'handler companion.

Non esistono volutamente operazioni di cancellazione permanente, valutazione JavaScript, accesso alla shell, avvio di processi figlio, esecuzione di comandi Obsidian arbitrari, gestione dei plugin o accesso diretto via filesystem ai percorsi delle note. Gestione completa non è una capacità `eval` o terminale.

## Impostazioni condivise

Bridge Control 0.5.7 mantiene atomicamente il formato rigoroso versione 5:

- Windows: `%LOCALAPPDATA%\ObsidianBridge\settings.json`
- macOS: `~/Library/Application Support/ObsidianBridge/settings.json`
- Linux: `$XDG_CONFIG_HOME/ObsidianBridge/settings.json` oppure `~/.config/ObsidianBridge/settings.json`

Le impostazioni versione 2 migrano ad Accesso protetto. L'Accesso completo della versione 3 resta Accesso autonomo e non riceve alcun permesso di gestione. Le voci versione 4 conservano le scelte esplicite, ma restano senza accesso finché quel vault non viene aperto e Bridge Control registra il vero `Vault.configDir`; durante la migrazione viene rimosso ogni ambito salvato che interseca la cartella di configurazione. La versione 5 rifiuta combinazioni di gestione non valide e tratta una cartella di configurazione sconosciuta come accesso negato. Impostazioni mancanti, malformate, obsolete o non verificabili chiudono l'accesso in modo prudente; la cache locale del plugin non può ripristinare un profilo elevato.

Il file condiviso conserva ID stabile del vault, percorso locale normalizzato, cartella di configurazione reale, modalità di accesso, cartelle relative autorizzate e i tre valori booleani di gestione. Non memorizza il corpo delle note.

Gli amministratori possono reindirizzare esplicitamente il file condiviso con la variabile d'ambiente `OBSIDIAN_BRIDGE_SETTINGS_PATH` prima di avviare Obsidian. Bridge Control non accetta mai questo percorso dai dati del plugin del vault.

I percorsi devono essere percorsi Markdown normalizzati e relativi al vault. Sono rifiutati percorsi assoluti, attraversamenti, `.`, `..`, percorsi con backslash e posizioni nascoste come `.obsidian` e `.trash`.

## Privacy e sicurezza

- Nessuna richiesta di rete o telemetria.
- Il pannello elenca le cartelle ma non analizza i corpi delle note. L'handler di gestione legge soltanto la nota coinvolta in una richiesta autenticata.
- Una richiesta di sostituzione con scadenza breve può contenere il nuovo corpo proposto. Il file richiesta locale viene acquisito una sola volta e rimosso prima della modifica; non viene mai inviato in rete.
- I backup di recupero contengono il corpo precedente della nota interessata e condividono il pool locale degli ultimi 20 JSON nella cartella dati di Obsidian Bridge. Non vengono mostrati da **Problemi recenti** né restituiti dallo strumento audit, che espone solo metadati; conserva un backup indipendente.
- L'audit può contenere percorsi, tipo di operazione, hash, esito, ID del backup, stato del recupero e valori limitati `failure_stage` e `cause_code`, ma mai messaggi grezzi delle eccezioni, output della CLI, testo delle note, contenuto proposto o corpo dei backup.
- L'accesso filesystem Node è limitato agli archivi esterni documentati: impostazioni condivise e relativo stato di lock/quarantena, registro Obsidian di sola lettura e con limite dimensionale, richieste di gestione monouso, backup di recupero e record audit composti solo da metadati. Il contenuto e la modifica delle note usano soltanto API pubbliche di Obsidian.
- La diagnostica CLI parte soltanto dopo un clic esplicito. Controlla un override d'ambiente o percorsi di installazione noti, mai il `PATH` generale, e non avvia alcun eseguibile. Il bridge esterno esegue la verifica definitiva della CLI quando viene richiesta un'operazione che la utilizza.
- Il canale di gestione accetta esclusivamente `bridge-control:commit` con ID richiesta monouso e token a 256 bit. Il contenuto della nota non viene passato come argomento della CLI.

## Build

```shell
npm ci
npm run check
```

Per una prova manuale copia `main.js`, `manifest.json` e `styles.css` in:

```text
<vault>/.obsidian/plugins/bridge-control/
```

Poi ricarica Obsidian e abilita **Bridge Control** tra i plugin della community. Le operazioni gestite richiedono Obsidian 1.12.7 o successivo, la CLI ufficiale abilitata per il bridge esterno e la versione corrispondente Obsidian Bridge 0.5.7.

Questo progetto è indipendente e non è affiliato né approvato da Obsidian.
