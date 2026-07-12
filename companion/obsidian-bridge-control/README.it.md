# Bridge Control

[English](README.md) · [Italiano](README.it.md)

Bridge Control è il companion desktop di Obsidian Bridge. La versione 0.5.0 aggiunge il profilo esplicito **Gestione completa** per modificare note e frontmatter, rinominare o spostare file e trasferirli nel cestino di Obsidian all'interno del vault corrente.

## Comportamento iniziale

Al primo avvio:

- l'accesso è associato all'ID stabile e al percorso locale del vault corrente;
- la lettura resta disattivata finché l'utente non seleziona cartelle o l'intero vault idoneo;
- la scrittura e tutti i permessi di gestione sono disattivati;
- il profilo iniziale è **Accesso protetto**;
- nessuna cartella è preimpostata e nessun aggiornamento aumenta i permessi in silenzio.

Il pannello include un selettore visuale ricercabile, checkbox separate **Leggi** e **Scrivi**, controlli verificati per la modalità di accesso, diagnostica della CLI ufficiale di Obsidian e una vista **Problemi recenti**.

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

Prima della modifica, l'handler salva un backup locale di recupero. Poi verifica il risultato, registra i metadati nell'audit condiviso e tenta un rollback limitato se un'operazione applicata solo in parte non raggiunge la condizione attesa. Le richieste sono serializzate e consumate una sola volta.

Non esistono volutamente operazioni di cancellazione permanente, valutazione JavaScript, accesso alla shell, esecuzione di comandi Obsidian arbitrari, gestione dei plugin o accesso filesystem senza limiti. Gestione completa non è una capacità `eval` o terminale.

## Impostazioni condivise

Bridge Control 0.5.0 mantiene atomicamente il formato rigoroso versione 4:

- Windows: `%LOCALAPPDATA%\ObsidianBridge\settings.json`
- macOS: `~/Library/Application Support/ObsidianBridge/settings.json`
- Linux: `$XDG_CONFIG_HOME/ObsidianBridge/settings.json` oppure `~/.config/ObsidianBridge/settings.json`

Le impostazioni versione 2 migrano ad Accesso protetto. L'Accesso completo della versione 3 resta Accesso autonomo e non riceve alcun permesso di gestione. La versione 4 rifiuta permessi di gestione fuori da Gestione completa e rifiuta Gestione completa senza almeno una capacità selezionata. Impostazioni mancanti, malformate, obsolete o non verificabili chiudono l'accesso in modo prudente; la cache locale del plugin non può ripristinare un profilo elevato.

Il file condiviso conserva ID stabile del vault, percorso locale normalizzato, modalità di accesso, cartelle relative autorizzate e i tre valori booleani di gestione. Non memorizza il corpo delle note.

Gli amministratori possono reindirizzare esplicitamente il file condiviso con la variabile d'ambiente `OBSIDIAN_BRIDGE_SETTINGS_PATH` prima di avviare Obsidian. Bridge Control non accetta mai questo percorso dai dati del plugin del vault.

I percorsi devono essere percorsi Markdown normalizzati e relativi al vault. Sono rifiutati percorsi assoluti, attraversamenti, `.`, `..`, percorsi con backslash e posizioni nascoste come `.obsidian` e `.trash`.

## Privacy e sicurezza

- Nessuna richiesta di rete o telemetria.
- Il pannello elenca le cartelle ma non analizza i corpi delle note. L'handler di gestione legge soltanto la nota coinvolta in una richiesta autenticata.
- Una richiesta di sostituzione con scadenza breve può contenere il nuovo corpo proposto. Il file richiesta locale viene acquisito una sola volta e rimosso prima della modifica; non viene mai inviato in rete.
- I backup di recupero contengono il corpo precedente della nota interessata e condividono il pool locale degli ultimi 20 JSON nella cartella dati di Obsidian Bridge. Non vengono mostrati da **Problemi recenti** né restituiti dallo strumento audit, che espone solo metadati; conserva un backup indipendente.
- L'audit contiene percorsi, tipo di operazione, hash, esito, ID del backup e stato del recupero, ma non il corpo delle note o dei backup.
- Il plugin legge il registro globale `obsidian.json`, con limite dimensionale, fuori dal vault soltanto per associare i permessi all'ID stabile del vault corrente.
- La diagnostica CLI parte soltanto dopo un clic esplicito. Controlla un override d'ambiente o percorsi di installazione noti, mai il `PATH` generale, esegue soltanto `version` senza shell e accetta solo un formato versione Obsidian riconosciuto.
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

Poi ricarica Obsidian e abilita **Bridge Control** tra i plugin della community. Le operazioni gestite richiedono Obsidian 1.12.7 o successivo, la CLI ufficiale abilitata e la versione corrispondente Obsidian Bridge 0.5.0.

Questo progetto è indipendente e non è affiliato né approvato da Obsidian.
