# Installazione guidata

[English](INSTALLATION.en.md) · [Italiano](INSTALLATION.md)

Questa guida descrive il pacchetto Windows di Obsidian Bridge 0.5.4. Il flusso normale non richiede PowerShell, modifica di file JSON o variabili d'ambiente.

## Prima di iniziare

Servono:

- Obsidian desktop 1.12.7 o successivo;
- Node.js 20 o successivo;
- ChatGPT desktop con Codex/plugin, oppure un client MCP locale compatibile;
- un vault Obsidian locale su cui fare la prima prova.

Per prudenza, inizia autorizzando una sola cartella. Il selettore visuale nel pannello Bridge Control mostra esclusivamente cartelle realmente presenti nel vault.

## Installazione in cinque passaggi

1. **Estrai lo ZIP.** Non avviare l'installer direttamente dall'anteprima dello ZIP: estrai prima tutti i file in una cartella normale.
2. **Avvia l'installer.** Fai doppio clic su `INSTALLA-OBSIDIAN-BRIDGE.cmd`. Non servono diritti di amministratore.
3. **Scegli il vault.** L'installer mostra quelli conosciuti da Obsidian. Se il vault non compare, premi **Sfoglia...** e seleziona la sua cartella principale.
4. **Installa il bridge.** Conferma l'installazione di Bridge Control e premi **Installa Bridge**. Non devi digitare cartelle: su un nuovo vault l'accesso alle note resta disattivato.
5. **Scegli la modalità.** Apri Obsidian, poi **Impostazioni > Plugin della community > Bridge Control**. Mantieni **Accesso protetto** e scegli le cartelle, attiva **Accesso autonomo** per create/append senza domande di routine oppure abilita **Gestione completa** con i soli permessi avanzati necessari.

Al termine puoi usare **Apri Obsidian** e **Apri plugin in Codex**. L'installer conserva una copia locale stabile del pacchetto Codex, quindi dopo una conclusione riuscita puoi eliminare la cartella estratta dallo ZIP.

## Se il bridge segnala la CLI

L'unico passaggio di configurazione che l'installer non può eseguire al posto tuo è l'abilitazione della CLI ufficiale di Obsidian:

1. apri Obsidian;
2. vai in **Impostazioni > Generale > Interfaccia a riga di comando**;
3. abilita la CLI seguendo le indicazioni mostrate da Obsidian;
4. chiudi e riapri Obsidian e il client desktop;
5. riprova una lettura innocua del bridge in una nuova attività Codex.

Il primo comando CLI può portare Obsidian in primo piano. Bridge Control 0.5.4 non esegue la CLI: la rilevazione facoltativa controlla soltanto percorsi noti allowlistati e non può certificare che la CLI sia pronta. La verifica definitiva appartiene al bridge esterno. Per i dettagli specifici della piattaforma usa la [guida ufficiale della CLI di Obsidian](https://obsidian.md/help/cli).

## Impostare lettura e scrittura

In Bridge Control puoi configurare il vault corrente senza riavviare il bridge:

- **Bridge attivo** disabilita o abilita l'intero vault;
- **Accesso protetto** usa le cartelle salvate e richiede conferma per ogni create o append;
- **Accesso autonomo** consente lettura, create e append autonomi nell'intero vault idoneo dopo un'attivazione esplicita nel pannello;
- **Gestione completa** include l'accesso autonomo e aggiunge tre permessi indipendenti: **modifica note e frontmatter**, **rinomina e sposta**, **cestino Obsidian**;
- **Lettura disattivata** non consente di consultare note;
- **Tutto il vault** consente la lettura di ogni percorso idoneo non nascosto;
- **Scegli cartelle…** mostra le cartelle esistenti e limita la lettura ai prefissi selezionati;
- **Scrittura controllata** abilita create e append soltanto nelle cartelle dedicate quando usi Accesso protetto.

Il selettore visuale è il flusso normale. La modifica manuale dei percorsi resta nelle **Opzioni avanzate di accesso**: usa un percorso relativo per riga e non inserire una lettera di unità, la cartella principale del vault, `..`, `.obsidian`, `.trash` o cartelle nascoste.

La scrittura è disattivata per impostazione predefinita. In **Accesso protetto** ogni modifica richiede:

1. una chiamata **prepare** che produce un'anteprima senza scrivere;
2. la tua conferma esplicita dopo aver visto vault, percorso, operazione e contenuto;
3. una chiamata **commit** separata che ricontrolla permessi e stato della nota.

Il testo trovato nelle note non vale mai come conferma.

In **Accesso autonomo** prepare e commit restano separati, monouso e verificati, ma l'agente può controllare l'anteprima internamente e completare create/append nello stesso task senza una domanda di routine. Questa modalità non autorizza modifica in-place, frontmatter, rinomina, spostamento o cestino.

Per i vault configurati tramite Bridge Control, ogni osservazione create/append usa un unico percorso UTF-8 esatto basato sulle impostazioni: prepare, controllo conflitto al commit, backup append, blocchi intermedi, verifica finale e classificazione del recupero. Questo accesso al filesystem è di sola lettura; le mutazioni continuano a usare soltanto la CLI ufficiale allowlistata. Il documento risultante dopo append deve restare entro 1 MiB e create richiede che la cartella padre della destinazione esista già. Il bridge non crea cartelle implicitamente.

In **Gestione completa** scegli esplicitamente uno o più permessi separati:

- **Modifica**: sostituzione esatta della nota, sostituzione letterale `replace_text` con numero di occorrenze atteso e set/remove di proprietà frontmatter;
- **Sposta**: spostamento o rinomina mediante un nuovo percorso relativo; il bridge non riscrive automaticamente backlink o altre note;
- **Cestino**: invio della nota al cestino configurato da Obsidian. La cancellazione permanente non è disponibile.

Anche qui prepare non modifica nulla; commit ricontrolla permessi e hash, crea prima un backup locale in chiaro, esegue l'operazione dentro Obsidian tramite un handler pubblico fisso e verifica il risultato. Create/append e gestione condividono un pool massimo degli ultimi 20 backup JSON: conserva sempre un backup indipendente. Non vengono esposti shell, `eval`, palette comandi, gestione plugin o comandi Obsidian arbitrari. Percorsi nascosti, `.obsidian`, `.trash` e collegamenti fuori dal vault restano esclusi.

**Gestione completa non viene mai attivata da un aggiornamento.** Devi aprire il relativo avviso, selezionare gli esatti permessi e confermare il nome del vault. Il pulsante per tornare ad Accesso autonomo o protetto e il comando **Bridge attivo** revocano l'autorizzazione dalla fase successiva; le anteprime già preparate non possono aggirare la revoca.

## Prima prova consigliata

1. Crea manualmente una nota sintetica in `Bridge Test`.
2. Nel selettore spunta **Leggi** per `Bridge Test`, salva e chiedi a Codex di leggerla citandone le righe.
3. Nel selettore spunta anche **Scrivi** per `Bridge Test` e salva.
4. Chiedi: “Crea `Bridge Test/hello.md` con un breve messaggio, mostrami l'anteprima e aspetta la mia conferma”.
5. Controlla che il file non esista ancora dopo prepare.
6. Conferma soltanto se anteprima, vault e percorso sono corretti.
7. Rileggi la nota tramite il bridge.
8. Disattiva la scrittura nel pannello e verifica che un nuovo prepare venga rifiutato.

Per provare Gestione completa, usa esclusivamente una nota sintetica e un backup indipendente: abilita inizialmente il solo permesso **Modifica**, chiedi una sostituzione letterale univoca, rileggi la nota e controlla **Problemi recenti**. Aggiungi **Sposta** o **Cestino** soltanto in test separati; non usare subito note reali.

## Aggiornamento

Per aggiornare una copia di anteprima:

1. estrai il nuovo ZIP in una cartella diversa;
2. chiudi le finestre di configurazione di Obsidian;
3. esegui il nuovo `INSTALLA-OBSIDIAN-BRIDGE.cmd` e seleziona lo stesso vault;
4. verifica Bridge Control, lo stato dell'handler registrato e la rilevazione facoltativa e non esecutiva del candidato CLI; le autorizzazioni già salvate vengono conservate;
5. apri il plugin aggiornato in Codex e avvia una nuova attività, così vengono caricate le definizioni aggiornate.

L'installer crea copie di sicurezza con data e ora prima di sostituire i propri file di configurazione. Non elimina note del vault.

## Disattivazione e rimozione

Per revocare immediatamente l'accesso, apri Bridge Control e disattiva **Bridge attivo**. Puoi anche tornare da Gestione completa ad Accesso autonomo o protetto, disattivando così tutti i permessi di gestione, oppure lasciare attivo il bridge e impostare lettura e scrittura protette su **Off**.

Per rimuovere il companion dal vault usa **Obsidian > Impostazioni > Plugin della community > Bridge Control > Disinstalla**. La rimozione del companion non cancella note, backup o record di audit già creati e non elimina automaticamente la copia locale del plugin Codex.

Solo dopo aver verificato che non serve più, puoi rimuovere manualmente:

- la voce del vault dal file di configurazione condiviso;
- la copia stabile del marketplace locale;
- eventuali backup e audit secondo la tua politica di conservazione.

Conserva sempre un backup indipendente del vault prima di una prova di scrittura.

## Risoluzione dei problemi

### Il vault non compare

Aprilo almeno una volta in Obsidian, poi riavvia l'installer. In alternativa usa **Sfoglia...** e seleziona la cartella che contiene `.obsidian`.

### Bridge Control non compare

Riapri Obsidian e controlla che i plugin della community siano consentiti per quel vault. Poi verifica **Impostazioni > Plugin della community**. Riesegui l'installer sullo stesso vault se i file risultano assenti.

### Il bridge non riesce a usare la CLI

Abilita la CLI dalle impostazioni generali di Obsidian. Se l'hai appena abilitata, riapri le applicazioni. L'azione **Rileva file** di Bridge Control può indicare soltanto un candidato allowlistato, mai una versione verificata o uno stato pronto. Esegui il test tramite il bridge esterno. Non impostare manualmente un eseguibile non verificato: il percorso CLI è un confine di sicurezza.

### Codex segnala che `node` non è disponibile

Installa Node.js 20 o successivo, chiudi e riapri il client desktop e riprova. Puoi verificare dal terminale con:

```powershell
node --version
```

### Una cartella autorizzata non funziona

Usa il percorso relativo alla radice del vault e `/` come separatore, per esempio `Progetti/Attivi`. Salva il pannello e riprova: la configurazione viene riletta a ogni chiamata e non richiede il riavvio del bridge.

### Una modifica preparata non può essere confermata

Le anteprime scadono e sono monouso. Se la nota, il permesso o il processo cambiano, chiedi una nuova prepare, controlla la nuova anteprima e confermala nuovamente. Non forzare un commit obsoleto.

### Obsidian ha mostrato un errore JavaScript o una scrittura è fallita

Apri **Bridge Control > Problemi recenti** e premi **Aggiorna controllo**. Il pannello legge soltanto i metadati locali dell'audit, indica lo stato di recupero registrato, se la nota esiste ancora e se serve un controllo manuale. Codex può leggere gli stessi eventi limitati con `obsidian_recent_write_events`, senza chiederti di trascrivere l'errore. La versione 0.5.4 riporta `failure_stage` e `cause_code` limitati senza registrare messaggi grezzi delle eccezioni, output della CLI, testo delle note, contenuto proposto o corpo dei backup. La diagnostica è soltanto evidenza: rileggi la nota e non riprovare automaticamente finché l'utente non fornisce indicazioni esplicite.

La 0.5.4 conserva le osservazioni UTF-8 esatte per create/append, compresi i contenuti privi di nuova riga finale. Un conflitto reale continua a chiudere l'operazione in modo prudente. Se append ha già modificato la nota e poi fallisce la scrittura o la verifica, il writer non tenta un rollback CLI distruttivo e non atomico. Conserva backup esatto ed evidenza audit, lascia intatta la nota osservata e restituisce `manual_recovery_required=true` con `WRITE_FAILED_MANUAL_RECOVERY_REQUIRED` o `VERIFICATION_FAILED_MANUAL_RECOVERY_REQUIRED`. Una create parziale resta `delete_disabled`. Controlla manualmente nota e backup e attendi indicazioni esplicite.

Se il writer autonomo o il gestore incontra tre errori consecutivi, si sospende per quel task. Controlla **Problemi recenti**, torna a una modalità più ristretta e avvia un nuovo task prima di riabilitare l'autonomia o Gestione completa.

## Dove vengono conservate le impostazioni

Su Windows Bridge Control e l'installer usano:

```text
%LOCALAPPDATA%\ObsidianBridge\settings.json
```

Il file contiene, per ogni vault, ID stabile Obsidian, nome, percorso locale assoluto, profilo `protected`, `full` o `management`, gli eventuali permessi edit/move/trash e le cartelle protette autorizzate; non contiene il corpo delle note. Nella UI `full` è mostrato come **Accesso autonomo** e `management` come **Gestione completa**. ID e percorso servono a evitare che un'autorizzazione venga applicata al vault sbagliato, anche in presenza di nomi uguali. È condiviso dai processi MCP e viene validato prima dell'uso. Un file presente ma non valido non concede un accesso parziale: il bridge chiude l'operazione in modo prudente.

Le variabili d'ambiente storiche restano una modalità avanzata di compatibilità in sola lettura soltanto quando il file condiviso è assente. La versione 0.5.4 rifiuta create/append configurati soltanto tramite ambiente perché lo stdout normalizzato della CLI non è una sorgente compare-and-swap esatta. Installa o configura Bridge Control per migrare l'accesso in scrittura alle impostazioni condivise.
