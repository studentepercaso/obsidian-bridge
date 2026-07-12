OBSIDIAN BRIDGE 0.4.1 - INSTALLER WINDOWS
=========================================

Installazione semplice
----------------------
1. Estrai tutto lo ZIP in una cartella locale.
2. Fai doppio clic su INSTALLA-OBSIDIAN-BRIDGE.cmd.
3. Scegli il vault, conferma e premi Installa Bridge.
4. In Obsidian apri Bridge Control e scegli una modalita:
   - Accesso protetto: seleziona le cartelle Leggi/Scrivi e salva.
   - Accesso completo: leggi l avviso con attenzione e attivalo solo
     confermando l autorizzazione dedicata per quel vault.

Non servono diritti di amministratore. Nessuna API key richiesta: il bridge
usa la CLI locale ufficiale di Obsidian.

Dati richiesti e controllati dal pannello
-----------------------------------------
- Vault Obsidian gia aperto almeno una volta nell app desktop.
- Node.js 20 o successivo per eseguire il plugin Codex. Se manca o e troppo
  vecchio, il pannello lo segnala e mostra il pulsante per il sito ufficiale:
  https://nodejs.org/en/download
- CLI ufficiale di Obsidian. Se non viene rilevata, abilitala nelle
  impostazioni di Obsidian. L installer non installa software in silenzio.

Cosa autorizza la casella di consenso
-------------------------------------
La casella autorizza l installazione e abilitazione del plugin community
"Bridge Control" nel vault selezionato e la copia stabile del connettore
locale per Codex. Le cartelle non si digitano nell installer: si scelgono
dal pannello visuale dentro Obsidian. Una nuova installazione non concede
accesso alle note e parte in Accesso protetto. L installer non abilita mai
Accesso completo: richiede sempre l attivazione esplicita dentro Bridge Control.
Un aggiornamento conserva le autorizzazioni e gli errori gia segnati come
controllati.

Cosa viene installato
---------------------
- Il companion Bridge Control nel solo vault selezionato.
- Nessuna nota o cartella viene creata nella configurazione iniziale predefinita.
- La configurazione condivisa schema v3, legata all ID stabile a 16 caratteri
  registrato in obsidian.json e non soltanto al nome visualizzato del vault.
- Una copia stabile del plugin Codex in:

    %LOCALAPPDATA%\ObsidianBridge\codex-marketplace

Il pannello finale mostra anche il percorso esatto di marketplace.json. Usalo
come fallback se il link codex:// non si apre. Dopo il primo avvio, Bridge
Control apre automaticamente il pannello dei permessi dentro Obsidian, dove
un selettore ricercabile mostra soltanto le cartelle realmente presenti.

Modalita di accesso in Bridge Control
-------------------------------------
- Accesso protetto (consigliato): usa soltanto gli scope di lettura e scrittura
  scelti. Ogni creazione o aggiunta richiede anteprima e conferma separata.
- Accesso completo (opt-in): dopo un avviso e una conferma esplicita per il
  singolo vault, consente lettura, creazione e aggiunta autonome sulle note
  visibili. Non abilita eliminazione, rinomina, spostamento, shell o
  sovrascrittura arbitraria. Restano attivi controlli di percorso, hash,
  backup, lock e audit.
- Tornare ad Accesso protetto e immediato e conserva le precedenti scelte per
  cartella.

Problemi recenti
----------------
Bridge Control include la sezione Problemi recenti. Legge in sola lettura i
metadati locali del registro audit, senza mostrare il contenuto delle note, e
indica se una scrittura e stata fermata, ripristinata o richiede un controllo
manuale. Permette di aprire la nota coinvolta, se esiste, e segnare il problema
come controllato. Prima di riprovare una modifica fallita, aggiorna questo
controllo e verifica lo stato attuale della nota.

Percorso configurazione condivisa
---------------------------------
Il valore predefinito e:

    %LOCALAPPDATA%\ObsidianBridge\settings.json

Se OBSIDIAN_BRIDGE_SETTINGS_PATH e valorizzata, deve essere un percorso
assoluto valido e diventa il percorso usato sia dall installer sia dal bridge.
Il file usa lo schema esatto versione 3. Una configurazione valida v2 viene
migrata in modo prudente a v3 con Accesso protetto; la migrazione non concede
mai Accesso completo. File v1, JSON malformato, campi aggiuntivi o limiti
superati vengono rifiutati senza sovrascrittura.

Sicurezza e recupero
--------------------
- Vault, .obsidian, destinazioni e antenati esistenti con junction o symlink
  che reindirizzano il percorso vengono rifiutati. I normali placeholder cloud
  di OneDrive restano supportati.
- Il merge del file condiviso avviene sotto il lock settings.json.lock, usando
  lo stesso protocollo di Bridge Control.
- Prima di sostituire file esistenti vengono creati backup con data e ora.
- Se un passaggio fallisce, l installer prova a ripristinare payload e JSON e
  segnala chiaramente qualsiasi stato parziale che richieda controllo manuale.

Rimozione
---------
In Obsidian apri:

    Impostazioni > Plugin della community > Bridge Control > Disinstalla

L installer non elimina automaticamente note o configurazioni. Conserva i
file *.backup.* finche non hai verificato che tutto funzioni.

Verifica senza modifiche
------------------------
Da PowerShell puoi controllare un vault senza scrivere file:

  powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
    .\installer\Install-ObsidianBridge.ps1 -DryRun `
    -VaultPath "C:\percorso\del\vault"

DryRun non acquisisce lock, non crea cartelle e non modifica file. Per un vault
nuovo mostra scope prudente; per uno gia configurato mostra le autorizzazioni
che un aggiornamento conserverebbe, inclusa la modalita accessMode. Il report
include anche lo stato di Node.js, ma una dipendenza mancante non rende il
DryRun distruttivo ne tenta installazioni automatiche.
