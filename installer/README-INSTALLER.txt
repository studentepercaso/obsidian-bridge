OBSIDIAN BRIDGE 0.5.8 - INSTALLER WINDOWS
=========================================

Installazione semplice
----------------------
1. Estrai tutto lo ZIP in una cartella locale.
2. Fai doppio clic su INSTALLA-OBSIDIAN-BRIDGE.cmd.
3. Scegli il vault, conferma e premi Installa Bridge.
4. In Obsidian apri Bridge Control e scegli una modalita:
   - Accesso protetto: seleziona le cartelle Leggi/Scrivi e salva.
   - Accesso autonomo: lettura, creazione e aggiunta sull intero vault.
   - Gestione completa: scegli separatamente modifica, spostamento e cestino,
     poi conferma l avviso dedicato per quel vault.

Non servono diritti di amministratore. Nessuna API key richiesta: il bridge
usa la CLI locale ufficiale di Obsidian.

L interfaccia WPF adattiva manda a capo percorsi e messaggi lunghi e mantiene
raggiungibili tutti i comandi tramite scorrimento anche in finestre compatte o
con un ridimensionamento elevato dello schermo di Windows.

Dati richiesti e controllati dal pannello
-----------------------------------------
- Vault Obsidian gia aperto almeno una volta nell app desktop.
- Node.js 20 o successivo per eseguire il plugin Codex. Se manca o e troppo
  vecchio, il pannello lo segnala e mostra il pulsante per il sito ufficiale:
  https://nodejs.org/en/download
- CLI ufficiale di Obsidian. Bridge Control non la esegue: Rileva file mostra
  soltanto un candidato non certificato da percorsi noti allowlistati. La
  verifica definitiva avviene nel bridge esterno. L installer non installa
  software in silenzio.

Cosa autorizza la casella di consenso
-------------------------------------
La casella autorizza l installazione e abilitazione del plugin community
"Bridge Control" nel vault selezionato e la copia stabile del connettore
locale per Codex. Le cartelle non si digitano nell installer: si scelgono
dal pannello visuale dentro Obsidian. Una nuova installazione non concede
accesso alle note e parte in Accesso protetto. L installer non abilita mai
Accesso autonomo o Gestione completa: richiedono sempre un attivazione
esplicita dentro Bridge Control.
Un aggiornamento conserva le autorizzazioni e gli errori gia segnati come
controllati.

Cosa viene installato
---------------------
- Il companion Bridge Control nel solo vault selezionato.
- Nessuna nota o cartella viene creata nella configurazione iniziale predefinita.
- La configurazione condivisa schema v5, legata all ID stabile a 16 caratteri
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
- Accesso autonomo (opt-in): dopo un avviso e una conferma esplicita per il
  singolo vault, consente lettura, creazione e aggiunta autonome sulle note
  visibili, ma non modifica in-place, rinomina, sposta o cestina.
- Gestione completa (opt-in, rischio elevato): autorizza soltanto le caselle
  selezionate tra modifica/frontmatter, rinomina/spostamento e cestino
  Obsidian. Ogni operazione usa anteprima, hash, richiesta monouso, backup,
  verifica e audit. La cancellazione permanente, shell, eval e comandi
  arbitrari non sono disponibili.
- Tornare ad Accesso protetto e immediato e conserva le precedenti scelte per
  cartella.

Problemi recenti
----------------
Bridge Control include la sezione Problemi recenti. Legge in sola lettura i
metadati locali del registro audit, senza mostrare il contenuto delle note. La
versione 0.5.8 puo mostrare una fase di errore limitata e un codice causa sicuro,
ma mai messaggi grezzi delle eccezioni, output della CLI, contenuto proposto o
corpo dei backup. Indica se una scrittura e stata fermata, ripristinata o richiede
un controllo manuale. La versione 0.5.8 usa la stessa osservazione UTF-8 esatta
basata sulle impostazioni per prepare create/append, controllo conflitto,
acquisizione backup, verifica dei blocchi e finale e classificazione del
recupero. Le mutazioni usano ancora soltanto la CLI ufficiale allowlistata.
Ogni proposta create/append accetta al massimo 64 KiB di contenuto UTF-8 e la
relativa anteprima completa e limitata a 192 KiB. Il documento risultante dopo
append resta limitato a 1 MiB. I contenuti lunghi vengono suddivisi in frame CLI
completi di non piu di 3072 byte UTF-8. Destinazioni create con cartella padre
mancante vengono rifiutate prima della mutazione. Il writer legacy configurato soltanto
tramite ambiente richiede la migrazione a Bridge Control.

Create/append non esegue mai rollback CLI automatici e distruttivi. Dopo un
errore successivo alla mutazione conserva backup esatto ed evidenza audit,
lascia intatta la nota osservata e segnala manual_recovery_required. Una create
parziale resta delete_disabled. La diagnostica e soltanto evidenza: verifica lo
stato attuale della nota e attendi indicazioni umane esplicite prima del recupero
o di un nuovo tentativo.

Percorso configurazione condivisa
---------------------------------
Il valore predefinito e:

    %LOCALAPPDATA%\ObsidianBridge\settings.json

Se OBSIDIAN_BRIDGE_SETTINGS_PATH e valorizzata, deve essere un percorso
assoluto valido e diventa il percorso usato sia dall installer sia dal bridge.
Il file usa lo schema esatto versione 5 e un ID stabile di 16 caratteri.
L installer non deduce mai la cartella di configurazione attiva dalla sola
presenza di una cartella: voci nuove, aggiornate o valide v2, v3 e v4 restano
senza accesso finche Bridge Control non gira in quel vault e registra il vero Vault.configDir.
Le scelte restano conservate e nessuna migrazione concede permessi di gestione. File v1,
JSON malformato, campi aggiuntivi o stati incoerenti vengono rifiutati senza
sovrascrittura.

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

Installazione automatizzata (avanzata)
--------------------------------------
Per installare senza interfaccia grafica usa entrambi gli switch espliciti:

  powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
    .\installer\Install-ObsidianBridge.ps1 -Install `
    -AcceptInstallation -VaultPath "C:\percorso\del\vault"

`-Install` richiede sempre un percorso vault completo e `-AcceptInstallation`.
Quest ultimo conferma soltanto l installazione del companion Bridge Control e
del connettore Codex locale; non concede accesso alle note e non abilita
Accesso autonomo o Gestione completa. Il comando non apre finestre e restituisce
un report JSON. In caso di errore restituisce exit code 1 e un errore JSON su
stderr.
