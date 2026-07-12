# Obsidian Bridge

[English](README.md) · [Italiano](README.it.md)

[![CI](https://github.com/studentepercaso/obsidian-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/studentepercaso/obsidian-bridge/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/studentepercaso/obsidian-bridge?display_name=tag)](https://github.com/studentepercaso/obsidian-bridge/releases)
[![Licenza: MIT](https://img.shields.io/badge/licenza-MIT-green.svg)](LICENSE)
[![Piattaforma: Windows](https://img.shields.io/badge/installer-Windows-0078D4.svg)](#requisiti)

Obsidian Bridge collega Codex e gli host plugin desktop ChatGPT compatibili ai vault Obsidian locali. Può cercare e leggere le note e, soltanto quando lo abiliti, creare una nota o aggiungere testo. Le autorizzazioni per vault e cartelle si gestiscono dal pannello **Bridge Control** dentro Obsidian.

> [!WARNING]
> Questa è un'anteprima pubblica indipendente, non un prodotto ufficiale Obsidian o OpenAI. Inizia con un vault usa-e-getta o una cartella di prova e conserva un backup indipendente.

> [!IMPORTANT]
> I contenuti restituiti dal bridge arrivano all'host MCP e possono essere inviati al modello che risponde alla richiesta. Il bridge non contiene client di rete, telemetria, account o indici remoti. Prima di autorizzare note riservate, leggi [PRIVACY.md](PRIVACY.md).

## Cosa include

- Installer guidato per Windows con rilevamento dei vault e senza privilegi di amministratore.
- Pannello visuale in Obsidian con **Accesso protetto** per cartelle oppure **Accesso completo** esplicito per lavorare in autonomia sull'intero vault.
- Nove strumenti di sola lettura limitati per ricerca, estratti, struttura, link, tag, backlink, note recenti e diagnostica delle scritture basata solo sui metadati.
- Due processi di scrittura separati, entrambi limitati a **create** e **append**: uno protetto con conferma e uno autonomo abilitato soltanto per i vault in accesso completo.
- Protocollo in due passaggi con anteprima e commit monouso; la conferma per ogni modifica resta obbligatoria in accesso protetto.
- Accesso iniziale negato, impostazioni per vault, esclusione delle cartelle nascoste, controllo dei percorsi, timeout e limiti di output.
- Lock condiviso tra processi, backup locali per append, audit senza il corpo delle note, pannello **Problemi recenti** e diagnostica audit limitata leggibile direttamente da Codex dopo un errore.

## Installazione rapida su Windows

1. Scarica **Obsidian-Bridge-Setup-0.4.1.zip** dalla [pagina delle release](https://github.com/studentepercaso/obsidian-bridge/releases).
2. Estrai completamente lo ZIP. Non eseguire l'installer dall'anteprima dell'archivio.
3. Fai doppio clic su **INSTALLA-OBSIDIAN-BRIDGE.cmd**.
4. Scegli un vault e completa l'installazione guidata.
5. In Obsidian apri **Impostazioni → Plugin della community → Bridge Control**.
6. Mantieni **Accesso protetto** e scegli le cartelle, oppure attiva una volta **Accesso completo** se vuoi consentire lettura e scrittura autonoma in tutto il vault.
7. Avvia una nuova attività Codex e prova una nota sintetica.

L'installer lascia i nuovi vault senza accesso finché non scegli le cartelle e conserva le autorizzazioni Bridge Control esistenti durante un aggiornamento. La procedura completa è in [docs/INSTALLATION.md](docs/INSTALLATION.md).

Usa l'asset il cui nome inizia con **Obsidian-Bridge-Setup**. Gli archivi **Source code** generati automaticamente da GitHub sono copie per sviluppatori, non l'installer guidato. I valori SHA-256 sono pubblicati accanto a ogni release in **SHA256-0.4.1.txt**.

Se la diagnostica segnala che la CLI di Obsidian non è disponibile, abilitala in **Obsidian → Impostazioni → Generale → Interfaccia a riga di comando**. Il bridge usa la CLI locale ufficiale e non simula l'accesso al vault tramite un servizio HTTP.

## Installazione tramite marketplace Codex

Gli utenti avanzati possono aggiungere questo repository pubblico come marketplace Codex:

```powershell
codex plugin marketplace add studentepercaso/obsidian-bridge --ref 0.4.1
codex plugin add obsidian-bridge@obsidian-bridge-community
```

Il marketplace installa il componente plugin Codex. L'installer della release resta il percorso consigliato perché installa anche **Bridge Control** nel vault selezionato e crea la configurazione locale condivisa.

## Modello dei permessi e della scrittura

Ogni vault ha due profili. **Accesso protetto** limita lettura e scrittura alle scelte salvate e richiede conferma per ogni modifica. **Accesso completo**, attivato con un avviso e una conferma unica nel pannello, consente lettura e scrittura autonoma nell'intero vault idoneo. Puoi tornare immediatamente al profilo protetto senza perdere le vecchie cartelle selezionate.

Ogni modifica usa due chiamate:

1. **Prepare** valida vault, percorso, autorizzazione, stato sorgente e contenuto proposto. Restituisce un'anteprima limitata senza modificare la nota.
2. **Commit** accetta soltanto quell'anteprima non scaduta e monouso e ricontrolla permessi e stato della sorgente. In accesso protetto avviene solo dopo conferma esplicita; in accesso completo può seguire automaticamente l'anteprima interna nello stesso task.

L'accesso completo non rende disponibili operazioni distruttive: il bridge non può eliminare, rinominare, spostare, sovrascrivere file arbitrari, eseguire comandi shell, gestire plugin o invocare comandi Obsidian arbitrari. Percorsi nascosti, `.obsidian`, `.trash` e collegamenti fuori dal vault restano esclusi. Lettura, scrittura protetta e scrittura autonoma usano processi MCP distinti con criteri di approvazione differenti.

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
- [Privacy](PRIVACY.md)
- [Sicurezza](SECURITY.md)
- [Cronologia delle versioni](CHANGELOG.md)
- [Contribuire](CONTRIBUTING.md)
- [Supporto](SUPPORT.md)
- [Licenze delle dipendenze](THIRD_PARTY_NOTICES.md)

## Stato del progetto

La versione 0.4.1 è un'anteprima pubblica distribuita dalla community tramite GitHub. Il companion **Bridge Control** è pubblicato anche in un repository autonomo pronto per la candidatura alla directory ufficiale dei Community Plugin di Obsidian. L'architettura MCP locale stdio non equivale a un endpoint MCP ospitato e al momento non è stata inviata alla directory universale dei plugin OpenAI.

Obsidian è un marchio di Dynalist Inc. ChatGPT, Codex e OpenAI sono marchi di OpenAI. Questo progetto indipendente non è affiliato né approvato da tali aziende.
