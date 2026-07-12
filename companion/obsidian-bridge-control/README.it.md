# Bridge Control

[English](README.md) · [Italiano](README.it.md)

Bridge Control è il companion desktop di Obsidian Bridge. Permette di scegliere tra accesso protetto per cartelle e accesso completo/autonomo per il vault corrente, oltre a mostrare i problemi recenti di scrittura.

## Comportamento iniziale

Al primo avvio:

- l'accesso è associato all'identità del vault corrente;
- la lettura resta disattivata finché non scegli cartelle o l'intero vault idoneo;
- la scrittura è disattivata;
- la modalità iniziale è **Accesso protetto**;
- nessuna cartella è preimpostata.

Il pannello include un selettore visuale ricercabile, checkbox separate **Leggi** e **Scrivi**, un'attivazione esplicita una tantum per **Accesso completo**, copertura ricorsiva delle sottocartelle, salvataggio con rilettura di verifica, diagnostica della CLI ufficiale di Obsidian e **Problemi recenti**.

## Impostazioni condivise

Il companion legge la versione 2 come accesso protetto e aggiorna atomicamente il file condiviso alla versione 3:

- Windows: `%LOCALAPPDATA%\ObsidianBridge\settings.json`
- macOS: `~/Library/Application Support/ObsidianBridge/settings.json`
- Linux: `$XDG_CONFIG_HOME/ObsidianBridge/settings.json` oppure `~/.config/ObsidianBridge/settings.json`

Conserva ID stabile del vault, percorso locale normalizzato, modalità di accesso e cartelle relative autorizzate. Non memorizza il corpo delle note.

Gli amministratori possono reindirizzare esplicitamente il file di configurazione condiviso con la variabile d'ambiente `OBSIDIAN_BRIDGE_SETTINGS_PATH` prima di avviare Obsidian. Bridge Control non accetta mai questo percorso dai dati del plugin del vault.

I percorsi devono essere relativi al vault. Sono rifiutati percorsi assoluti, attraversamenti, `.`, `..` e cartelle nascoste come `.obsidian` e `.trash`.

## Privacy e sicurezza

- Nessuna richiesta di rete o telemetria.
- Il companion di configurazione non legge né scrive il contenuto delle note; Problemi recenti legge soltanto una coda limitata dell'audit senza corpi o backup.
- La Vault API di Obsidian viene usata soltanto per elencare le cartelle.
- Il plugin legge il registro globale `obsidian.json`, con limite dimensionale, fuori dal vault per associare i permessi all'ID stabile del vault corrente.
- Le scritture Node sono limitate al percorso deterministico del file condiviso fuori dal vault e ai dati propri del plugin. I dati salvati nel vault non possono reindirizzare quel percorso.
- La diagnostica CLI parte soltanto dopo un clic esplicito. Controlla un override d'ambiente o percorsi di installazione noti, mai il `PATH` generale, esegue soltanto `version` senza shell e accetta soltanto un formato versione Obsidian riconosciuto.
- Le modifiche alle note restano disattivate inizialmente. Accesso protetto usa anteprima e conferma esplicita; Accesso completo abilita soltanto il writer autonomo separato, mantenendo percorsi, hash, backup, lock e audit.

## Build

```shell
npm ci
npm run check
```

Per una prova manuale copia `main.js`, `manifest.json` e `styles.css` in:

```text
<vault>/.obsidian/plugins/bridge-control/
```

Poi ricarica Obsidian e abilita **Bridge Control** tra i plugin della community.

Questo progetto è indipendente e non è affiliato né approvato da Obsidian.
