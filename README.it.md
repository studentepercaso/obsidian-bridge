# Obsidian Bridge

[English](README.md) · [Italiano](README.it.md)

[![CI](https://github.com/studentepercaso/obsidian-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/studentepercaso/obsidian-bridge/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/studentepercaso/obsidian-bridge?display_name=tag)](https://github.com/studentepercaso/obsidian-bridge/releases)
[![Licenza: MIT](https://img.shields.io/badge/licenza-MIT-green.svg)](LICENSE)
[![Piattaforma: Windows](https://img.shields.io/badge/installer-Windows-0078D4.svg)](#requisiti)

Obsidian Bridge collega Codex e gli host plugin desktop ChatGPT compatibili ai vault Obsidian locali. Può cercare e leggere note, crearle o aggiungere contenuto e, soltanto dopo un'autorizzazione separata ed esplicita, gestire note Markdown esistenti. Le autorizzazioni per vault, cartelle e operazioni si controllano dal pannello **Bridge Control** dentro Obsidian.

> [!WARNING]
> Questa è un'anteprima pubblica indipendente, non un prodotto ufficiale Obsidian o OpenAI. Inizia con un vault usa-e-getta o una cartella di prova e conserva un backup indipendente.

> [!IMPORTANT]
> I contenuti restituiti dal bridge arrivano all'host MCP e possono essere inviati al modello che risponde alla richiesta. Il bridge non contiene client di rete, telemetria, account o indici remoti. Prima di autorizzare note riservate, leggi [PRIVACY.md](PRIVACY.md).

## Cosa include

- Installer WPF guidato e adattivo per Windows, nitido su schermi ad alta risoluzione, con rilevamento dei vault, marketplace locale verificato generato automaticamente e senza privilegi di amministratore.
- Pannello visuale in Obsidian con tre profili espliciti: **Accesso protetto** per cartelle, **Accesso autonomo** per tutto il vault e **Gestione completa** granulare.
- Nove strumenti di sola lettura limitati per ricerca, estratti, struttura, link, tag, backlink, note recenti e diagnostica delle scritture basata solo sui metadati.
- Processi separati per create/append protetti o autonomi e un processo dedicato alla gestione: sostituzione esatta, sostituzione letterale, frontmatter, spostamento/rinomina e invio al cestino di Obsidian.
- Protocollo in due passaggi con anteprima e commit monouso; la conferma per ogni modifica resta obbligatoria in accesso protetto.
- Accesso iniziale negato, impostazioni per vault, esclusione delle cartelle nascoste, controllo dei percorsi, timeout e limiti di output.
- Permessi **modifica**, **sposta** e **cestino** separati in Gestione completa; nessuno viene dedotto da aggiornamenti, note, prompt o variabili d'ambiente.
- Lock condiviso tra processi, al massimo 20 backup locali in chiaro condivisi, verifica del risultato, audit senza il corpo delle note, pannello **Problemi recenti** e diagnostica audit limitata leggibile direttamente da Codex dopo un errore. La versione 0.5.8 accetta fino a 64 KiB in una singola proposta create/append e verifica le note sincronizzate con letture ripetute e identiche byte per byte più una finestra finale limitata di stabilità dei metadati, evitando falsi conflitti dovuti a soli aggiornamenti Windows di `ctime` e continuando a respingere le vere modifiche.

## Installazione rapida su Windows

1. Scarica **Obsidian-Bridge-Setup-0.5.8.zip** dalla [pagina delle release](https://github.com/studentepercaso/obsidian-bridge/releases).
2. Estrai completamente lo ZIP. Non eseguire l'installer dall'anteprima dell'archivio.
3. Fai doppio clic su **INSTALLA-OBSIDIAN-BRIDGE.cmd**.
4. Scegli un vault e completa l'installazione guidata.
5. In Obsidian apri **Impostazioni → Plugin della community → Bridge Control**.
6. Mantieni **Accesso protetto** e scegli le cartelle, attiva **Accesso autonomo** per lettura/create/append in tutto il vault oppure abilita **Gestione completa** selezionando soltanto i permessi modifica, sposta o cestino necessari.
7. Avvia una nuova attività Codex e prova una nota sintetica.

L'installer lascia i nuovi vault senza accesso finché non scegli le cartelle e conserva le autorizzazioni Bridge Control esistenti durante un aggiornamento. La procedura completa è in [docs/INSTALLATION.md](docs/INSTALLATION.md).

Usa l'asset il cui nome inizia con **Obsidian-Bridge-Setup**. Gli archivi **Source code** generati automaticamente da GitHub sono copie per sviluppatori, non l'installer guidato. I valori SHA-256 sono pubblicati accanto a ogni release in **SHA256-0.5.8.txt**.

L'installer 0.5.8 usa un layout WPF adattivo: manda a capo percorsi e istruzioni lunghi, mantiene raggiungibili i comandi tramite scorrimento e si adatta alle finestre compatte e al ridimensionamento dello schermo di Windows.

Se la diagnostica segnala che la CLI di Obsidian non è disponibile, abilitala in **Obsidian → Impostazioni → Generale → Interfaccia a riga di comando**. Il bridge usa la CLI locale ufficiale e non simula l'accesso al vault tramite un servizio HTTP.

## Installazione tramite marketplace Codex

Gli utenti avanzati possono aggiungere questo repository pubblico come marketplace Codex:

```powershell
codex plugin marketplace add studentepercaso/obsidian-bridge --ref 0.5.8
codex plugin add obsidian-bridge@obsidian-bridge-community
```

Il marketplace installa il componente plugin Codex. L'installer della release resta il percorso consigliato perché installa anche **Bridge Control** nel vault selezionato e crea la configurazione locale condivisa.

## Modello dei permessi e della scrittura

Ogni vault ha tre profili:

- **Accesso protetto** usa le cartelle di lettura e scrittura salvate e richiede conferma per ogni create o append.
- **Accesso autonomo** (il profilo chiamato Accesso completo nelle versioni precedenti) consente lettura/create/append autonomi sui percorsi Markdown idonei e non nascosti dell'intero vault.
- **Gestione completa** include l'accesso autonomo e può autorizzare separatamente **modifica**, **sposta** e **cestino**. Modifica comprende sostituzione esatta dell'intera nota, `replace_text` letterale con conteggio e modifica set/remove del frontmatter. Sposta comprende spostamento e rinomina di un solo file, senza riscrivere backlink o altre note. Cestino usa il flusso di eliminazione di Obsidian; la cancellazione permanente non è mai esposta.

Accesso autonomo e Gestione completa richiedono un'attivazione esplicita nel pannello. Gestione completa registra inoltre l'esatto insieme di permessi confermato dall'utente. Tornare a un profilo più ristretto o disattivare un permesso ha effetto dalla fase successiva e conserva le scelte protette per cartella.

Ogni modifica usa due chiamate:

1. **Prepare** valida vault, percorso, autorizzazione, stato sorgente e contenuto proposto. Restituisce un'anteprima limitata senza modificare la nota.
2. **Commit** accetta soltanto quell'anteprima non scaduta e monouso e ricontrolla permessi e stato della sorgente. In Accesso protetto avviene solo dopo conferma esplicita; in Accesso autonomo o Gestione completa create/append possono seguire automaticamente l'anteprima interna nello stesso task.

Per i vault configurati tramite le impostazioni di Bridge Control, preparazione create/append, CAS al commit, acquisizione backup, controlli dei blocchi intermedi, verifica finale e classificazione del recupero leggono tutti la stessa rappresentazione UTF-8 esatta e limitata. Una singola proposta può contenere fino a 64 KiB, mentre il documento risultante deve restare entro 1 MiB. La lettura resta fisicamente confinata al vault autorizzato e non modifica mai direttamente una nota; le mutazioni create/append continuano a usare soltanto frame allowlistati della CLI ufficiale entro 3.072 byte UTF-8. Create richiede che la cartella padre esista già prima della mutazione. Il writer legacy configurato soltanto tramite variabili d'ambiente rifiuta create/append perché lo stdout normalizzato della CLI non è una sorgente CAS esatta: occorre migrare il vault tramite Bridge Control.

Create/append non esegue rollback CLI automatici e distruttivi dopo un errore successivo alla mutazione. Conserva il backup esatto e l'evidenza audit composta solo da metadati, lascia intatto lo stato osservato della nota e restituisce `manual_recovery_required=true`; una create parziale resta `delete_disabled`. Controlla la nota corrente e attendi indicazioni esplicite dell'utente. Un ripristino automatico atomico richiederebbe una futura transazione Bridge Control.

Le operazioni di Gestione completa usano una coppia prepare/commit dedicata. Prepare restituisce un'anteprima esatta e limitata senza modificare il vault e ricava l'hash del conflitto da uno snapshot UTF-8 esatto, non dall'output di lettura normalizzato dalla CLI. Commit consuma quell'anteprima non scaduta e monouso, ricontrolla permesso granulare e hash della sorgente sotto lock condivisi, crea un backup di recupero in chiaro, invoca soltanto l'handler fisso `bridge-control:commit` e verifica il risultato. La rinomina è espressa dall'operazione `move` con un nuovo percorso di destinazione.

L'handler gira dentro Obsidian. Sostituzione e frontmatter usano `Vault.process` con controllo compare-and-swap sull'hash sorgente preparato; il frontmatter viene letto e riscritto con gli helper YAML pubblici di Obsidian. Spostamento/rinomina usa `Vault.rename` e modifica deliberatamente soltanto il file selezionato: **non** riscrive backlink o altre note. Il cestino usa l'API pubblica di Obsidian. Il canale di gestione non espone cancellazione permanente, comandi arbitrari, palette comandi, gestione plugin, shell o `eval`. Percorsi nascosti, `.obsidian`, `.trash` e collegamenti fisici fuori dal vault restano esclusi. Lettore, writer protetto, writer autonomo e gestore usano processi MCP distinti con capacità diverse.

Bridge Control 0.5.8 non usa `child_process` e non avvia eseguibili. Il pannello CLI identifica soltanto un candidato non autorevole; il bridge esterno effettua la verifica definitiva quando necessario. Il selettore usa il vero `Vault.configDir` del vault. L'accesso filesystem Node del companion è limitato agli archivi esterni documentati per impostazioni/lock/quarantena, registro di sola lettura, richieste monouso, backup e audit, mai ai percorsi delle note; lettura e modifica delle note nel companion restano sulle API pubbliche di Obsidian. Queste modifiche di hardening non aggiungono permessi, campi del protocollo o superfici di scrittura.

Le impostazioni condivise usano ora lo schema versione 5 e conservano il vero `Vault.configDir` come regola di esclusione autorevole in ogni modalità del bridge. Le voci dalla versione 2 alla versione 4 conservano le scelte esplicite ma restano senza accesso finché quel vault non viene aperto e registra la cartella di configurazione reale; ogni ambito salvato che la interseca viene rimosso. La migrazione non inventa mai autorità.

## Requisiti

- Windows 10 o 11 per l'installer guidato di questa anteprima.
- Obsidian desktop 1.12.7 o successivo.
- CLI ufficiale di Obsidian abilitata quando richiesto dalla diagnostica.
- Node.js 20 o successivo.
- Codex/ChatGPT desktop con supporto plugin locale, oppure un host MCP locale compatibile con stdio e approvazione degli strumenti mutanti.

Obsidian deve essere in esecuzione in una sessione desktop interattiva. Questa release non si collega direttamente al sito web di ChatGPT.

## Sviluppo e verifica

```powershell
npm ci
npm --prefix companion/obsidian-bridge-control ci
npm run check:all
```

I test automatici usano una CLI simulata e dati sintetici. Una release richiede anche una prova manuale con la CLI ufficiale di Obsidian e un vault usa-e-getta. Vedi [docs/SUBMISSION_TESTS.md](docs/SUBMISSION_TESTS.md).

## Documentazione

- [Guida di installazione in italiano](docs/INSTALLATION.md)
- [English installation guide](docs/INSTALLATION.en.md)
- [Protocollo di scrittura controllata](docs/WRITING.md)
- [Note di rilascio bilingui 0.5.8](docs/RELEASE_NOTES_0.5.8.md)
- [Privacy](PRIVACY.md)
- [Sicurezza](SECURITY.md)
- [Cronologia delle versioni](CHANGELOG.md)
- [Contribuire](CONTRIBUTING.md)
- [Supporto](SUPPORT.md)
- [Licenze delle dipendenze](THIRD_PARTY_NOTICES.md)

## Stato del progetto

La versione 0.5.8 è un'anteprima pubblica distribuita dalla community tramite GitHub. Il companion **Bridge Control** è pubblicato anche in un repository autonomo ed è presente nella directory ufficiale dei Community Plugin di Obsidian. L'architettura MCP locale stdio non equivale a un endpoint MCP ospitato e al momento non è stata inviata alla directory universale dei plugin OpenAI.

Obsidian è un marchio di Dynalist Inc. ChatGPT, Codex e OpenAI sono marchi di OpenAI. Questo progetto indipendente non è affiliato né approvato da tali aziende.
