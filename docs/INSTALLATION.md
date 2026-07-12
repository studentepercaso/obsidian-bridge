# Installazione guidata

[English](INSTALLATION.en.md) · [Italiano](INSTALLATION.md)

Questa guida descrive il pacchetto Windows di Obsidian Bridge 0.4.0. Il flusso normale non richiede PowerShell, modifica di file JSON o variabili d'ambiente.

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
5. **Scegli la modalità.** Apri Obsidian, poi **Impostazioni > Plugin della community > Bridge Control**. Mantieni **Accesso protetto** e scegli le cartelle, oppure attiva **Accesso completo** con l'avviso esplicito se vuoi lavorare in autonomia sull'intero vault.

Al termine puoi usare **Apri Obsidian** e **Apri plugin in Codex**. L'installer conserva una copia locale stabile del pacchetto Codex, quindi dopo una conclusione riuscita puoi eliminare la cartella estratta dallo ZIP.

## Se il diagnostico segnala la CLI

L'unico passaggio di configurazione che l'installer non può eseguire al posto tuo è l'abilitazione della CLI ufficiale di Obsidian:

1. apri Obsidian;
2. vai in **Impostazioni > Generale > Interfaccia a riga di comando**;
3. abilita la CLI seguendo le indicazioni mostrate da Obsidian;
4. chiudi e riapri Obsidian e il client desktop se la diagnostica non si aggiorna subito;
5. torna in **Bridge Control** ed esegui nuovamente la diagnostica.

Il primo comando CLI può portare Obsidian in primo piano. Per i dettagli specifici della piattaforma usa la [guida ufficiale della CLI di Obsidian](https://obsidian.md/help/cli).

## Impostare lettura e scrittura

In Bridge Control puoi configurare il vault corrente senza riavviare il bridge:

- **Bridge attivo** disabilita o abilita l'intero vault;
- **Accesso protetto** usa le cartelle salvate e richiede conferma per ogni scrittura;
- **Accesso completo** consente lettura e scrittura autonoma nell'intero vault dopo una sola conferma nel pannello;
- **Lettura disattivata** non consente di consultare note;
- **Tutto il vault** consente la lettura di ogni percorso idoneo non nascosto;
- **Scegli cartelle…** mostra le cartelle esistenti e limita la lettura ai prefissi selezionati;
- **Scrittura controllata** abilita create e append soltanto nelle cartelle dedicate.

Il selettore visuale è il flusso normale. La modifica manuale dei percorsi resta nelle **Opzioni avanzate di accesso**: usa un percorso relativo per riga e non inserire una lettera di unità, la cartella principale del vault, `..`, `.obsidian`, `.trash` o cartelle nascoste.

La scrittura è disattivata per impostazione predefinita. In **Accesso protetto** ogni modifica richiede:

1. una chiamata **prepare** che produce un'anteprima senza scrivere;
2. la tua conferma esplicita dopo aver visto vault, percorso, operazione e contenuto;
3. una chiamata **commit** separata che ricontrolla permessi e stato della nota.

Il testo trovato nelle note non vale mai come conferma.

In **Accesso completo** prepare e commit restano separati, monouso e verificati, ma l'agente può controllare l'anteprima internamente e completare il commit nello stesso task senza una domanda di routine. Questa modalità non abilita eliminazione, rinomina, spostamento, shell o sovrascrittura arbitraria. Percorsi nascosti, `.obsidian`, `.trash` e collegamenti fuori dal vault restano esclusi. Il pulsante **Torna ad accesso protetto** revoca immediatamente l'autonomia e ripristina le scelte per cartella conservate.

## Prima prova consigliata

1. Crea manualmente una nota sintetica in `Bridge Test`.
2. Nel selettore spunta **Leggi** per `Bridge Test`, salva e chiedi a Codex di leggerla citandone le righe.
3. Nel selettore spunta anche **Scrivi** per `Bridge Test` e salva.
4. Chiedi: “Crea `Bridge Test/hello.md` con un breve messaggio, mostrami l'anteprima e aspetta la mia conferma”.
5. Controlla che il file non esista ancora dopo prepare.
6. Conferma soltanto se anteprima, vault e percorso sono corretti.
7. Rileggi la nota tramite il bridge.
8. Disattiva la scrittura nel pannello e verifica che un nuovo prepare venga rifiutato.

## Aggiornamento

Per aggiornare una copia di anteprima:

1. estrai il nuovo ZIP in una cartella diversa;
2. chiudi le finestre di configurazione di Obsidian;
3. esegui il nuovo `INSTALLA-OBSIDIAN-BRIDGE.cmd` e seleziona lo stesso vault;
4. verifica nuovamente Bridge Control e la diagnostica; le autorizzazioni già salvate vengono conservate;
5. apri il plugin aggiornato in Codex e avvia una nuova attività, così vengono caricate le definizioni aggiornate.

L'installer crea copie di sicurezza con data e ora prima di sostituire i propri file di configurazione. Non elimina note del vault.

## Disattivazione e rimozione

Per revocare immediatamente l'accesso, apri Bridge Control e disattiva **Bridge attivo**. In alternativa, lascia attivo il bridge e imposta la lettura su **Disattivata** e la scrittura su **Off**.

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

### La diagnostica non trova la CLI

Abilita la CLI dalle impostazioni generali di Obsidian. Se l'hai appena abilitata, riapri le applicazioni. Non impostare manualmente un eseguibile non verificato: il percorso CLI è un confine di sicurezza.

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

Apri **Bridge Control > Problemi recenti** e premi **Aggiorna controllo**. Il pannello legge soltanto i metadati locali dell'audit, indica se il ripristino è riuscito, se la nota esiste ancora e se serve un controllo manuale. La versione 0.4.0 divide automaticamente i testi lunghi in richieste CLI sicure e verifica ogni blocco, evitando il crash JSON noto di Obsidian 1.12.7 su Windows. Non riprovare automaticamente una modifica fallita prima di aver controllato lo stato attuale della nota.

Se il writer autonomo incontra tre errori consecutivi, si sospende per quel task. Controlla **Problemi recenti**, torna ad **Accesso protetto** e avvia un nuovo task prima di riabilitare l'autonomia.

## Dove vengono conservate le impostazioni

Su Windows Bridge Control e l'installer usano:

```text
%LOCALAPPDATA%\ObsidianBridge\settings.json
```

Il file contiene, per ogni vault, ID stabile Obsidian, nome, percorso locale assoluto, profilo protetto/completo e cartelle autorizzate; non contiene il corpo delle note. ID e percorso servono a evitare che un'autorizzazione venga applicata al vault sbagliato, anche in presenza di nomi uguali. È condiviso dai processi MCP e viene validato prima dell'uso. Un file presente ma non valido non concede un accesso parziale: il bridge chiude l'operazione in modo prudente.

Le variabili d'ambiente storiche restano una modalità avanzata di compatibilità soltanto quando il file condiviso è assente. Per l'installazione normale usa Bridge Control, che applica impostazioni specifiche per vault ed evita configurazioni globali difficili da verificare.
