import {
  App,
  ButtonComponent,
  DropdownComponent,
  FileSystemAdapter,
  getFrontMatterInfo,
  Modal,
  Notice,
  parseYaml,
  Platform,
  Plugin,
  PluginSettingTab,
  SearchComponent,
  Setting,
  TFile,
  TextAreaComponent,
  ToggleComponent,
  stringifyYaml,
} from "obsidian";
import {
  CliDiagnostic,
  DesktopPlatform,
  ManagementPermissions,
  ReadMode,
  VaultBridgeSettings,
  VaultIdentity,
  diagnoseCli,
  disabledManagementPermissions,
  mergeVaultSettings,
  parseFolderList,
  readVaultSettings,
  resolveVaultIdentity,
  sharedSettingsPath,
} from "./shared-settings";
import {
  FolderAccessSelection,
  collapseFolderSelection,
  coveringParent,
  folderIsInside,
  hiddenFolder,
} from "./folder-selection";
import {
  AuditDiagnosticsResult,
  bridgeDataDirectory,
  readAuditDiagnostics,
} from "./audit-diagnostics";
import { coerceProtectedLocalSettings } from "./local-settings";
import { runConfirmedActivation } from "./activation-flow";
import {
  ManagementRequestHandler,
  type ManagementAuthorizationDecision,
  type ManagementAuthorizationPhase,
  type ManagementVaultApi,
} from "./management-handler";
import {
  hashPresentDocument,
  type ManagementRequest,
} from "./management-protocol";

const PLUGIN_DATA_VERSION = 4;

const DEFAULT_SETTINGS: VaultBridgeSettings = {
  accessMode: "protected",
  managementPermissions: disabledManagementPermissions(),
  enabled: true,
  readMode: "off",
  readFolders: [],
  writeEnabled: false,
  writeFolders: [],
};

interface VerificationState {
  ok: boolean;
  at: string;
  message: string;
}

interface DraftValidation {
  settings?: VaultBridgeSettings;
  errors: string[];
  warnings: string[];
}

function currentPlatform(): DesktopPlatform {
  if (Platform.isWin) return "windows";
  if (Platform.isMacOS) return "macos";
  return "linux";
}

function copySettings(settings: VaultBridgeSettings): VaultBridgeSettings {
  return {
    accessMode: settings.accessMode,
    managementPermissions: { ...settings.managementPermissions },
    enabled: settings.enabled,
    readMode: settings.readMode,
    readFolders: [...settings.readFolders],
    writeEnabled: settings.writeEnabled,
    writeFolders: [...settings.writeFolders],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsedFrontMatter(content: string): Record<string, unknown> {
  const info = getFrontMatterInfo(content);
  if (!info.exists) return {};
  const parsed: unknown = parseYaml(info.frontmatter);
  if (parsed === null || parsed === undefined) return {};
  if (!isRecord(parsed)) {
    throw new Error("Il frontmatter persistito non è un oggetto YAML valido.");
  }
  return parsed;
}

function rewriteFrontMatter(
  content: string,
  update: (frontmatter: Record<string, unknown>) => void,
): string {
  const info = getFrontMatterInfo(content);
  const frontmatter = parsedFrontMatter(content);
  update(frontmatter);
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const serialized = stringifyYaml(frontmatter)
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "\n")
    .replace(/\n+$/u, "");
  const yaml = serialized.length === 0
    ? ""
    : `${serialized.replace(/\n/gu, eol)}${eol}`;
  if (info.exists) {
    return `${content.slice(0, info.from)}${yaml}${content.slice(info.to)}`;
  }
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  return `${bom}---${eol}${yaml}---${eol}${content.slice(bom.length)}`;
}

function changeConflict(message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code: "CHANGE_CONFLICT" as const });
}

function managementCapability(
  operation: ManagementRequest["operation"],
): keyof ManagementPermissions {
  if (operation === "replace" || operation === "frontmatter") return "edit";
  return operation === "move" ? "move" : "trash";
}

function reviewedChangeIds(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.reviewedAuditChangeIds)) return [];
  return value.reviewedAuditChangeIds
    .filter(
      (item): item is string =>
        typeof item === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
          item,
        ),
    )
    .slice(-100);
}

function describeReading(settings: VaultBridgeSettings): string {
  if (settings.enabled && settings.accessMode !== "protected") return "Tutto il vault";
  if (!settings.enabled || settings.readMode === "off") return "Disattivata";
  if (settings.readMode === "all") return "Tutto il vault";
  return settings.readFolders.length > 0 ? settings.readFolders.join(", ") : "Nessuna cartella";
}

function describeWriting(settings: VaultBridgeSettings): string {
  if (settings.enabled && settings.accessMode !== "protected") {
    return "Tutto il vault · automatica";
  }
  if (!settings.enabled || !settings.writeEnabled) return "Disattivata";
  return settings.writeFolders.length > 0 ? settings.writeFolders.join(", ") : "Nessuna cartella";
}

class FolderAccessModal extends Modal {
  private readonly readable = new Set<string>();
  private readonly writable = new Set<string>();

  constructor(
    app: App,
    initial: FolderAccessSelection,
    private readonly onApply: (selection: FolderAccessSelection) => void,
  ) {
    super(app);
    for (const folder of collapseFolderSelection(initial.readFolders)) this.readable.add(folder);
    for (const folder of collapseFolderSelection(initial.writeFolders)) this.writable.add(folder);
  }

  onOpen(): void {
    this.modalEl.addClass("bridge-control-folder-modal");
    this.contentEl.empty();
    this.contentEl.addClass("bridge-control-folder-picker");
    this.contentEl.createEl("h2", { text: "Scegli l'accesso alle cartelle" });
    this.contentEl.createEl("p", {
      text: "Spunta Leggi e Scrivi sulle cartelle che vuoi rendere disponibili. Una cartella include automaticamente tutte le sue sottocartelle.",
      cls: "bridge-control-folder-picker__intro",
    });

    const folders = this.app.vault
      .getAllFolders(false)
      .map((folder) => folder.path)
      .filter((path) => path.length > 0 && !hiddenFolder(path))
      .sort((left, right) => left.localeCompare(right, "it", { numeric: true, sensitivity: "base" }));

    const searchHost = this.contentEl.createDiv({ cls: "bridge-control-folder-picker__search" });
    const search = new SearchComponent(searchHost).setPlaceholder("Cerca una cartella, per esempio Progetti");
    const list = this.contentEl.createDiv({ cls: "bridge-control-folder-picker__list" });
    const footer = this.contentEl.createDiv({ cls: "bridge-control-folder-picker__footer" });
    const selectionSummary = footer.createDiv({ cls: "bridge-control-folder-picker__selection" });
    const footerButtons = footer.createDiv({ cls: "bridge-control-folder-picker__buttons" });
    let query = "";

    const replaceSet = (target: Set<string>, foldersToUse: Iterable<string>): void => {
      target.clear();
      for (const folder of collapseFolderSelection(foldersToUse)) target.add(folder);
    };

    const render = (): void => {
      list.empty();
      const visibleFolders = folders.filter((folder) => folder.toLocaleLowerCase("it").includes(query));
      if (visibleFolders.length === 0) {
        list.createEl("p", {
          text: folders.length === 0 ? "Questo vault non contiene ancora cartelle selezionabili." : "Nessuna cartella corrisponde alla ricerca.",
          cls: "bridge-control-folder-picker__empty",
        });
      }

      for (const folder of visibleFolders) {
        const row = list.createDiv({ cls: "bridge-control-folder-picker__row" });
        const folderCell = row.createDiv({ cls: "bridge-control-folder-picker__folder" });
        const depth = Math.max(0, folder.split("/").length - 1);
        folderCell.addClass(`bridge-folder-depth-${Math.min(depth, 6)}`);
        folderCell.createSpan({ text: folder });

        const readParent = coveringParent(folder, this.readable);
        const readLabel = row.createEl("label", { cls: "bridge-control-folder-picker__check" });
        const readInput = readLabel.createEl("input");
        readInput.type = "checkbox";
        readInput.checked = this.readable.has(folder) || readParent !== undefined;
        readInput.disabled = readParent !== undefined;
        readInput.setAttr("aria-label", `Consenti lettura di ${folder}`);
        readLabel.createSpan({ text: readParent ? "Inclusa" : "Leggi" });
        if (readParent) readLabel.setAttr("title", `Inclusa da ${readParent}`);
        readInput.addEventListener("change", () => {
          if (readInput.checked) {
            replaceSet(this.readable, [...this.readable, folder]);
          } else {
            this.readable.delete(folder);
            replaceSet(
              this.writable,
              [...this.writable].filter((candidate) => !folderIsInside(candidate, folder)),
            );
          }
          render();
        });

        const writeParent = coveringParent(folder, this.writable);
        const writeLabel = row.createEl("label", { cls: "bridge-control-folder-picker__check" });
        const writeInput = writeLabel.createEl("input");
        writeInput.type = "checkbox";
        writeInput.checked = this.writable.has(folder) || writeParent !== undefined;
        writeInput.disabled = writeParent !== undefined;
        writeInput.setAttr("aria-label", `Consenti scrittura in ${folder}`);
        writeLabel.createSpan({ text: writeParent ? "Inclusa" : "Scrivi" });
        if (writeParent) writeLabel.setAttr("title", `Inclusa da ${writeParent}`);
        writeInput.addEventListener("change", () => {
          if (writeInput.checked) {
            replaceSet(this.writable, [...this.writable, folder]);
            if (![...this.readable].some((parent) => folderIsInside(folder, parent))) {
              replaceSet(this.readable, [...this.readable, folder]);
            }
          } else {
            this.writable.delete(folder);
          }
          render();
        });
      }

      const readCount = this.readable.size;
      const writeCount = this.writable.size;
      selectionSummary.setText(`Lettura: ${readCount} ${readCount === 1 ? "cartella" : "cartelle"} · Scrittura: ${writeCount} ${writeCount === 1 ? "cartella" : "cartelle"}`);
    };

    search.onChange((value) => {
      query = value.trim().toLocaleLowerCase("it");
      render();
    });
    search.inputEl.setAttr("aria-label", "Cerca tra le cartelle del vault");

    const clearButton = footerButtons.createEl("button", { text: "Pulisci" });
    clearButton.addEventListener("click", () => {
      this.readable.clear();
      this.writable.clear();
      render();
    });
    const cancelButton = footerButtons.createEl("button", { text: "Annulla" });
    cancelButton.addEventListener("click", () => this.close());
    const applyButton = footerButtons.createEl("button", {
      text: "Applica selezione",
      cls: "mod-cta",
    });
    applyButton.addEventListener("click", () => {
      this.onApply({
        readFolders: collapseFolderSelection(this.readable),
        writeFolders: collapseFolderSelection(this.writable),
      });
      this.close();
    });

    render();
    window.setTimeout(() => search.inputEl.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class AutonomousAccessConfirmationModal extends Modal {
  constructor(
    app: App,
    private readonly vaultName: string,
    private readonly onConfirm: () => Promise<void>,
    private readonly onConfirmed: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("bridge-control-confirm-modal");
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "Attiva accesso autonomo" });
    this.contentEl.createEl("p", {
      text: `Nel vault “${this.vaultName}” ChatGPT potrà leggere tutte le note visibili, creare note e aggiungere testo senza chiedere conferma ogni volta.`,
    });
    const warning = this.contentEl.createDiv({
      cls: "bridge-control__warning bridge-control__full-warning",
    });
    warning.createEl("strong", { text: "Autorizzazione permanente per questo vault" });
    warning.createEl("p", {
      text: "Restano attivi controllo dei percorsi, backup, hash, verifica e registro attività. Eliminazione, rinomina, spostamento, shell e sovrascrittura arbitraria restano vietati.",
    });

    const acknowledgement = this.contentEl.createEl("label", {
      cls: "bridge-control__acknowledgement",
    });
    const checkbox = acknowledgement.createEl("input");
    checkbox.type = "checkbox";
    acknowledgement.createSpan({
      text: "Ho capito e autorizzo l'accesso autonomo a questo vault.",
    });

    const actions = this.contentEl.createDiv({
      cls: "bridge-control__action-buttons bridge-control__confirm-actions",
    });
    const cancel = actions.createEl("button", { text: "Annulla" });
    cancel.addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", {
      text: "Attiva accesso autonomo",
      cls: "mod-warning",
    });
    confirm.disabled = true;
    checkbox.addEventListener("change", () => {
      confirm.disabled = !checkbox.checked;
    });
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      cancel.disabled = true;
      confirm.setText("Attivazione…");
      const outcome = await runConfirmedActivation(this.onConfirm, () => {
        this.close();
        this.onConfirmed();
      });
      if (!outcome.activated) {
        new Notice(
          `Attivazione non riuscita: ${outcome.activationError instanceof Error ? outcome.activationError.message : String(outcome.activationError)}`,
        );
        cancel.disabled = false;
        confirm.disabled = !checkbox.checked;
        confirm.setText("Attiva accesso autonomo");
        return;
      }
      if (outcome.uiError !== undefined) {
        new Notice(
          `Accesso autonomo attivato e verificato, ma il pannello non è stato aggiornato. Chiudi e riapri le impostazioni. Dettaglio: ${outcome.uiError instanceof Error ? outcome.uiError.message : String(outcome.uiError)}`,
        );
      }
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class ManagementAccessConfirmationModal extends Modal {
  constructor(
    app: App,
    private readonly vaultName: string,
    private readonly initialPermissions: Readonly<ManagementPermissions>,
    private readonly onConfirm: (permissions: ManagementPermissions) => Promise<void>,
    private readonly onConfirmed: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("bridge-control-confirm-modal");
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "Configura Gestione completa" });
    this.contentEl.createEl("p", {
      text: `Nel vault “${this.vaultName}” ChatGPT potrà eseguire autonomamente soltanto le operazioni che autorizzi qui.`,
    });

    const warning = this.contentEl.createDiv({
      cls: "bridge-control__warning bridge-control__management-warning",
    });
    warning.createEl("strong", { text: "Operazioni che modificano note esistenti" });
    warning.createEl("p", {
      text: "Backup, hash, lock, verifica e registro attività restano obbligatori. Il cestino usa quello di Obsidian: la cancellazione definitiva resta vietata.",
    });

    const selected: ManagementPermissions = { ...this.initialPermissions };
    const permissionList = this.contentEl.createDiv({
      cls: "bridge-control__management-permissions",
    });
    let acknowledgementChecked = false;
    let confirm: HTMLButtonElement | undefined;
    const syncConfirm = (): void => {
      const anySelected = selected.edit || selected.move || selected.trash;
      if (confirm !== undefined) confirm.disabled = !acknowledgementChecked || !anySelected;
    };
    const addPermission = (
      key: keyof ManagementPermissions,
      title: string,
      description: string,
    ): void => {
      const label = permissionList.createEl("label", {
        cls: "bridge-control__management-permission",
      });
      const checkbox = label.createEl("input");
      checkbox.type = "checkbox";
      checkbox.checked = selected[key];
      const copy = label.createDiv();
      copy.createEl("strong", { text: title });
      copy.createEl("small", { text: description });
      checkbox.addEventListener("change", () => {
        selected[key] = checkbox.checked;
        syncConfirm();
      });
    };

    addPermission(
      "edit",
      "Modifica note e frontmatter",
      "Può sostituire contenuto già presente nelle note Markdown autorizzate.",
    );
    addPermission(
      "move",
      "Rinomina e sposta note",
      "Può cambiare nome o cartella. Non riscrive backlink o altre note: la loro eventuale correzione richiede Modifica.",
    );
    addPermission(
      "trash",
      "Sposta note nel cestino",
      "Può inviare note al cestino configurato in Obsidian, mai eliminarle definitivamente.",
    );

    const acknowledgement = this.contentEl.createEl("label", {
      cls: "bridge-control__acknowledgement",
    });
    const acknowledgementCheckbox = acknowledgement.createEl("input");
    acknowledgementCheckbox.type = "checkbox";
    acknowledgement.createSpan({
      text: "Ho compreso i rischi e autorizzo soltanto i permessi selezionati per questo vault.",
    });
    acknowledgementCheckbox.addEventListener("change", () => {
      acknowledgementChecked = acknowledgementCheckbox.checked;
      syncConfirm();
    });

    const actions = this.contentEl.createDiv({
      cls: "bridge-control__action-buttons bridge-control__confirm-actions",
    });
    const cancel = actions.createEl("button", { text: "Annulla" });
    cancel.addEventListener("click", () => this.close());
    confirm = actions.createEl("button", {
      text: "Attiva Gestione completa",
      cls: "mod-warning",
    });
    syncConfirm();
    confirm.addEventListener("click", async () => {
      if (confirm === undefined) return;
      confirm.disabled = true;
      cancel.disabled = true;
      confirm.setText("Verifica in corso…");
      const confirmedPermissions = { ...selected };
      const outcome = await runConfirmedActivation(
        () => this.onConfirm(confirmedPermissions),
        () => {
          this.close();
          this.onConfirmed();
        },
      );
      if (!outcome.activated) {
        new Notice(
          `Attivazione non riuscita: ${outcome.activationError instanceof Error ? outcome.activationError.message : String(outcome.activationError)}`,
        );
        cancel.disabled = false;
        confirm.setText("Attiva Gestione completa");
        syncConfirm();
        return;
      }
      if (outcome.uiError !== undefined) {
        new Notice(
          `Gestione completa attivata e verificata, ma il pannello non è stato aggiornato. Chiudi e riapri le impostazioni. Dettaglio: ${outcome.uiError instanceof Error ? outcome.uiError.message : String(outcome.uiError)}`,
        );
      }
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export default class BridgeControlPlugin extends Plugin {
  settings: VaultBridgeSettings = copySettings(DEFAULT_SETTINGS);
  sharedPath = "";
  verification: VerificationState | undefined;
  cliDiagnostic: CliDiagnostic | undefined;
  auditDiagnostics: AuditDiagnosticsResult | undefined;
  identity: VaultIdentity | undefined;
  private reviewedAuditChangeIds = new Set<string>();
  private localDataWriteQueue: Promise<unknown> = Promise.resolve();
  private settingsSaveQueue: Promise<unknown> = Promise.resolve();
  private managementHandler: ManagementRequestHandler | undefined;
  private managementUnavailableReason: string | undefined;
  private firstRun = false;

  private updateLocalData<T>(
    build: (loaded: unknown) => {
      readonly data?: unknown;
      readonly result: T;
      readonly skip?: boolean;
    },
  ): Promise<T> {
    const operation = this.localDataWriteQueue.then(async () => {
      const loaded: unknown = await this.loadData();
      const update = build(loaded);
      if (update.skip !== true) await this.saveData(update.data);
      return update.result;
    });
    this.localDataWriteQueue = operation.catch(() => undefined);
    return operation;
  }

  async onload(): Promise<void> {
    this.sharedPath = sharedSettingsPath(currentPlatform());
    this.firstRun = await this.loadSettings();

    try {
      this.registerManagementCliHandler();
    } catch (error) {
      // Keep the settings panel available, but leave management unavailable.
      // This is a startup error (not debug telemetry) and contains no note data.
      this.managementHandler = undefined;
      this.managementUnavailableReason =
        "Gestione completa non disponibile: il comando locale di modifica non è stato registrato. Riavvia Obsidian e verifica il pannello.";
      this.verification = {
        ok: false,
        at: new Date().toISOString(),
        message: this.managementUnavailableReason,
      };
      console.error("Bridge Control management handler is unavailable", error);
    }

    this.addSettingTab(new BridgeControlSettingTab(this.app, this));
    this.addRibbonIcon("sliders-horizontal", "Configura Bridge Control", () => {
      new BridgeControlModal(this.app, this, false).open();
    });
    this.addCommand({
      id: "open-control-panel",
      name: "Apri pannello di configurazione",
      callback: () => new BridgeControlModal(this.app, this, false).open(),
    });

    this.app.workspace.onLayoutReady(() => {
      if (!this.firstRun) return;
      new Notice("Bridge Control è pronto: completa la configurazione nel pannello guidato.", 8_000);
      new BridgeControlModal(this.app, this, true).open();
      void this.markPanelOpened();
    });
  }

  private async loadSettings(): Promise<boolean> {
    const loaded: unknown = await this.loadData();
    this.reviewedAuditChangeIds = new Set(reviewedChangeIds(loaded));
    const shouldOpenPanel =
      loaded === null ||
      loaded === undefined ||
      (isRecord(loaded) && loaded.openPanelOnNextLoad === true);
    const localSettings = coerceProtectedLocalSettings(loaded, DEFAULT_SETTINGS);
    try {
      this.identity = await resolveVaultIdentity(
        currentPlatform(),
        this.app.vault.getName(),
        this.vaultBasePath(),
      );
      const shared = await readVaultSettings(this.sharedPath, this.identity.id);
      if (shared !== undefined) {
        this.settings = shared;
        this.verification = {
          ok: true,
          at: new Date().toISOString(),
          message: "Configurazione condivisa caricata.",
        };
        return shouldOpenPanel;
      }
      this.settings = localSettings;
      this.verification = {
        ok: false,
        at: new Date().toISOString(),
        message: "Configurazione non ancora autorizzata: scegli le cartelle e premi Salva accesso.",
      };
      return true;
    } catch (error) {
      this.settings = copySettings(DEFAULT_SETTINGS);
      this.verification = {
        ok: false,
        at: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error),
      };
      return true;
    }
  }

  private async markPanelOpened(): Promise<void> {
    try {
      await this.updateLocalData((loaded) => ({
        ...(isRecord(loaded) && loaded.openPanelOnNextLoad === true
          ? { data: { ...loaded, openPanelOnNextLoad: false } }
          : { skip: true }),
        result: undefined,
      }));
    } catch {
      // This acknowledgement never changes the authoritative shared policy.
    }
  }

  private vaultBasePath(): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error("Bridge Control richiede un vault locale nell'app desktop.");
    }
    return adapter.getBasePath();
  }

  private markdownFile(filePath: string): TFile | null {
    const file = this.app.vault.getFileByPath(filePath);
    if (file === null) return null;
    if (file.extension.toLocaleLowerCase() !== "md") {
      throw new Error("La gestione controllata accetta soltanto note Markdown.");
    }
    return file;
  }

  private managementVaultApi(): ManagementVaultApi {
    return {
      readMarkdown: async (filePath) => {
        const file = this.markdownFile(filePath);
        return file === null ? null : await this.app.vault.read(file);
      },
      processMarkdown: async (filePath, update) => {
        const file = this.markdownFile(filePath);
        if (file === null) throw new Error("La nota da modificare non esiste.");
        return await this.app.vault.process(file, update);
      },
      rewriteFrontMatterMarkdown: async (
        filePath,
        beforeSha256,
        update,
      ) => {
        const file = this.markdownFile(filePath);
        if (file === null) throw new Error("La nota da modificare non esiste.");
        return await this.app.vault.process(file, (current) => {
          if (hashPresentDocument(current) !== beforeSha256) {
            throw changeConflict(
              "La nota è cambiata prima della modifica atomica del frontmatter.",
            );
          }
          return rewriteFrontMatter(current, update);
        });
      },
      readFrontMatter: async (filePath) => {
        const file = this.markdownFile(filePath);
        if (file === null) throw new Error("La nota da verificare non esiste.");
        const content = await this.app.vault.read(file);
        return parsedFrontMatter(content);
      },
      renameFile: async (filePath, destination) => {
        const file = this.markdownFile(filePath);
        if (file === null) throw new Error("La nota da spostare non esiste.");
        await this.app.vault.rename(file, destination);
      },
      trashFile: async (filePath) => {
        const file = this.markdownFile(filePath);
        if (file === null) throw new Error("La nota da cestinare non esiste.");
        await this.app.fileManager.trashFile(file);
      },
    };
  }

  private async authorizeManagementRequest(
    request: ManagementRequest,
    registeredIdentity: VaultIdentity,
    _phase: ManagementAuthorizationPhase,
  ): Promise<ManagementAuthorizationDecision> {
    const deny = (error_code: string): ManagementAuthorizationDecision => ({
      allowed: false,
      mode: "management",
      error_code,
    });

    try {
      // Re-resolve the physical vault and re-read the authoritative shared file
      // on both the initial and commit authorization phases. Cached UI state is
      // deliberately never consulted here.
      const currentIdentity = await resolveVaultIdentity(
        currentPlatform(),
        this.app.vault.getName(),
        this.vaultBasePath(),
      );
      if (
        currentIdentity.id !== registeredIdentity.id ||
        currentIdentity.id !== request.vault_id ||
        currentIdentity.path !== registeredIdentity.path
      ) {
        return deny("VAULT_IDENTITY_CHANGED");
      }

      const current = await readVaultSettings(this.sharedPath, currentIdentity.id);
      if (current === undefined) return deny("MANAGEMENT_CONFIGURATION_MISSING");
      if (!current.enabled) return deny("BRIDGE_DISABLED");
      if (current.accessMode !== "management") {
        return deny("MANAGEMENT_ACCESS_REVOKED");
      }
      if (!current.managementPermissions[managementCapability(request.operation)]) {
        return deny("MANAGEMENT_PERMISSION_REVOKED");
      }
      return { allowed: true, mode: "management" };
    } catch {
      return deny("AUTHORIZATION_FAILED");
    }
  }

  private registerManagementCliHandler(): void {
    const registeredIdentity = this.identity;
    if (registeredIdentity === undefined) {
      throw new Error("Vault identity is unavailable for management registration.");
    }

    const handler = new ManagementRequestHandler({
      dataDirectory: bridgeDataDirectory(currentPlatform()),
      vaultId: registeredIdentity.id,
      api: this.managementVaultApi(),
      authorize: async (request, phase) =>
        await this.authorizeManagementRequest(request, registeredIdentity, phase),
    });
    this.registerCliHandler(
      "bridge-control:commit",
      "Esegue una richiesta di Gestione completa già preparata e autorizzata.",
      {
        request: {
          value: "<uuid>",
          description: "ID monouso della richiesta preparata",
          required: true,
        },
        token: {
          value: "<64hex>",
          description: "Token monouso della richiesta preparata",
          required: true,
        },
      },
      async (params) =>
        await handler.handle({
          request_id: typeof params.request === "string" ? params.request : "",
          token: typeof params.token === "string" ? params.token : "",
        }),
    );
    this.managementHandler = handler;
    this.managementUnavailableReason = undefined;
  }

  async saveAndVerify(
    nextSettings: VaultBridgeSettings,
    options: {
      readonly fullAccessConfirmed?: boolean;
      readonly managementPermissionsConfirmed?: Readonly<ManagementPermissions>;
    } = {},
  ): Promise<void> {
    const operation = this.settingsSaveQueue.then(async () => {
      try {
        await this.performSaveAndVerify(nextSettings, options);
      } catch (error) {
        this.verification = {
          ok: false,
          at: new Date().toISOString(),
          message: error instanceof Error ? error.message : String(error),
        };
        throw error;
      }
    });
    this.settingsSaveQueue = operation.catch(() => undefined);
    return operation;
  }

  private async performSaveAndVerify(
    nextSettings: VaultBridgeSettings,
    options: {
      readonly fullAccessConfirmed?: boolean;
      readonly managementPermissionsConfirmed?: Readonly<ManagementPermissions>;
    },
  ): Promise<void> {
    const normalized = copySettings(nextSettings);
    if (
      normalized.accessMode === "management" &&
      this.managementHandler === undefined
    ) {
      throw new Error(
        this.managementUnavailableReason ??
          "Gestione completa non disponibile: il comando locale di modifica non è attivo. Riavvia Obsidian e riprova.",
      );
    }
    const identity = await resolveVaultIdentity(
      currentPlatform(),
      this.app.vault.getName(),
      this.vaultBasePath(),
    );

    const merged = await mergeVaultSettings(
      this.sharedPath,
      identity.id,
      identity.name,
      identity.path,
      normalized,
      options,
    );

    // Shared settings are authoritative. A failure of Obsidian's optional
    // per-vault cache must not make the UI claim activation or revocation failed.
    this.settings = copySettings(merged.settings);
    this.identity = identity;
    this.verification = {
      ok: true,
      at: new Date().toISOString(),
      message:
        merged.warning ?? "Configurazione salvata e riletta correttamente sotto lock.",
    };

    try {
      const storedReviewed = await this.updateLocalData((loaded) => {
        const ids = [
          ...new Set([
            ...reviewedChangeIds(loaded),
            ...this.reviewedAuditChangeIds,
          ]),
        ].slice(-100);
        return {
          data: {
            version: PLUGIN_DATA_VERSION,
            vaultId: identity.id,
            vaultName: identity.name,
            vaultPath: identity.path,
            accessMode: normalized.accessMode,
            managementPermissions: { ...normalized.managementPermissions },
            enabled: normalized.enabled,
            readMode: normalized.readMode,
            readFolders: normalized.readFolders,
            writeEnabled: normalized.writeEnabled,
            writeFolders: normalized.writeFolders,
            reviewedAuditChangeIds: ids,
            openPanelOnNextLoad: false,
          },
          result: ids,
        };
      });
      this.reviewedAuditChangeIds = new Set(storedReviewed);
    } catch (error) {
      this.verification = {
        ok: true,
        at: new Date().toISOString(),
        message: `Accesso condiviso attivo e verificato; cache locale non aggiornata: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  async refreshCliDiagnostic(): Promise<CliDiagnostic> {
    this.cliDiagnostic = await diagnoseCli(currentPlatform());
    return this.cliDiagnostic;
  }

  async refreshAuditDiagnostics(): Promise<AuditDiagnosticsResult> {
    if (this.identity === undefined) {
      throw new Error("Identità stabile del vault non disponibile.");
    }
    this.auditDiagnostics = await readAuditDiagnostics(this.identity.id, {
      platform: currentPlatform(),
      limit: 10,
    });
    return this.auditDiagnostics;
  }

  isAuditReviewed(changeId: string): boolean {
    return this.reviewedAuditChangeIds.has(changeId);
  }

  async markAuditReviewed(changeId: string): Promise<void> {
    const storedReviewed = await this.updateLocalData((loaded) => {
      const ids = [
        ...new Set([
          ...reviewedChangeIds(loaded),
          ...this.reviewedAuditChangeIds,
          changeId,
        ]),
      ].slice(-100);
      return {
        data: {
          ...(isRecord(loaded) ? loaded : {}),
          reviewedAuditChangeIds: ids,
        },
        result: ids,
      };
    });
    this.reviewedAuditChangeIds = new Set(storedReviewed);
  }
}

class BridgeControlSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly bridgePlugin: BridgeControlPlugin,
  ) {
    super(app, bridgePlugin);
  }

  display(): void {
    renderControlPanel(this.containerEl, this.bridgePlugin, false);
  }
}

class BridgeControlModal extends Modal {
  constructor(
    app: App,
    private readonly bridgePlugin: BridgeControlPlugin,
    private readonly firstRun: boolean,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("bridge-control-modal");
    renderControlPanel(this.contentEl, this.bridgePlugin, this.firstRun);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function renderControlPanel(
  containerEl: HTMLElement,
  plugin: BridgeControlPlugin,
  firstRun: boolean,
): void {
  containerEl.empty();
  containerEl.addClass("bridge-control");

  const draft = copySettings(plugin.settings);
  let readFoldersRaw = draft.readFolders.join("\n");
  let writeFoldersRaw = draft.writeFolders.join("\n");
  let dirty = false;

  const header = containerEl.createDiv({ cls: "bridge-control__header" });
  header.createEl("h2", { text: firstRun ? "Configuriamo il collegamento" : "Bridge Control" });
  header.createEl("p", {
    text: firstRun
      ? "Scegli le cartelle da collegare, poi premi Salva accesso."
      : "Scegli in modo semplice cosa può leggere e dove può scrivere ChatGPT.",
  });

  if (firstRun) {
    const welcome = containerEl.createDiv({ cls: "bridge-control__callout" });
    welcome.createEl("strong", { text: "Partenza sicura" });
    welcome.createEl("p", {
      text: `Lettura: ${describeReading(draft)}. Scrittura: ${describeWriting(draft)}. Nulla viene inviato in rete da questo pannello.`,
    });
  }

  const statusCard = containerEl.createDiv({ cls: "bridge-control__card bridge-control__status" });
  const validationEl = containerEl.createDiv({ cls: "bridge-control__validation" });

  const validateDraft = (): DraftValidation => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const readFolders = parseFolderList(readFoldersRaw);
    const writeFolders = parseFolderList(writeFoldersRaw);
    const anyManagementPermission =
      draft.managementPermissions.edit ||
      draft.managementPermissions.move ||
      draft.managementPermissions.trash;

    errors.push(...readFolders.errors.map((error) => `Lettura: ${error}`));
    errors.push(...writeFolders.errors.map((error) => `Scrittura: ${error}`));
    if (
      draft.accessMode === "protected" &&
      draft.readMode === "folders" &&
      readFolders.folders.length === 0
    ) {
      errors.push("Indica almeno una cartella leggibile oppure scegli un'altra modalità di lettura.");
    }
    if (
      draft.accessMode === "protected" &&
      draft.writeEnabled &&
      writeFolders.folders.length === 0
    ) {
      errors.push("Indica almeno una cartella scrivibile prima di abilitare la scrittura.");
    }
    if (readFolders.folders.length > 256 || writeFolders.folders.length > 256) {
      errors.push("Puoi configurare al massimo 256 cartelle per elenco.");
    }
    if (
      draft.accessMode === "protected" &&
      draft.writeEnabled &&
      draft.readMode === "off"
    ) {
      errors.push("Per usare la scrittura devi abilitare anche la lettura, necessaria per anteprima e verifica.");
    }
    if (
      draft.accessMode === "protected" &&
      draft.writeEnabled &&
      draft.readMode === "folders"
    ) {
      for (const writeFolder of writeFolders.folders) {
        if (!readFolders.folders.some((readFolder) => folderIsInside(writeFolder, readFolder))) {
          errors.push(`La cartella scrivibile “${writeFolder}” deve trovarsi dentro una cartella leggibile.`);
        }
      }
    }
    if (!draft.enabled) {
      warnings.push("Il bridge è disattivato per questo vault; le altre scelte restano salvate.");
    }
    if (draft.accessMode === "management" && !anyManagementPermission) {
      errors.push("Gestione completa richiede almeno un permesso selezionato.");
    }
    if (draft.accessMode !== "management" && anyManagementPermission) {
      errors.push("I permessi di gestione possono essere usati soltanto in Gestione completa.");
    }
    if (draft.enabled && draft.accessMode === "full") {
      warnings.push(
        "Accesso autonomo attivo: lettura, creazione e aggiunta nell'intero vault senza conferma per ogni modifica.",
      );
    }
    if (draft.enabled && draft.accessMode === "management") {
      warnings.push("Gestione completa attiva con i soli permessi selezionati nel pannello.");
    }

    if (errors.length > 0) return { errors, warnings };
    return {
      errors,
      warnings,
      settings: {
        accessMode: draft.accessMode,
        managementPermissions: { ...draft.managementPermissions },
        enabled: draft.enabled,
        readMode: draft.readMode,
        readFolders: readFolders.folders,
        writeEnabled: draft.writeEnabled,
        writeFolders: writeFolders.folders,
      },
    };
  };

  const renderStatus = (): void => {
    statusCard.empty();
    const titleRow = statusCard.createDiv({ cls: "bridge-control__card-title" });
    titleRow.createEl("h3", { text: `Vault: ${plugin.app.vault.getName()}` });
    titleRow.createSpan({
      text: draft.enabled ? "Attivo" : "Disattivato",
      cls: `bridge-control__badge ${draft.enabled ? "is-ok" : "is-off"}`,
    });

    const grid = statusCard.createDiv({ cls: "bridge-control__status-grid" });
    addStatusItem(grid, "Lettura", describeReading({
      ...draft,
      readFolders: parseFolderList(readFoldersRaw).folders,
    }));
    addStatusItem(grid, "Creazione e aggiunta", describeWriting({
      ...draft,
      writeFolders: parseFolderList(writeFoldersRaw).folders,
    }));
    const managementActive = draft.enabled && draft.accessMode === "management";
    addStatusItem(
      grid,
      "Modifica",
      managementActive && draft.managementPermissions.edit ? "Autorizzata" : "Disattivata",
    );
    addStatusItem(
      grid,
      "Rinomina e sposta",
      managementActive && draft.managementPermissions.move ? "Autorizzata" : "Disattivata",
    );
    addStatusItem(
      grid,
      "Cestino",
      managementActive && draft.managementPermissions.trash ? "Autorizzato" : "Disattivato",
    );
    addStatusItem(
      grid,
      "Modalità",
      draft.accessMode === "management"
        ? draft.enabled
          ? "Gestione completa"
          : "Gestione completa configurata · bridge disattivato"
        : draft.accessMode === "full"
          ? draft.enabled
            ? "Accesso autonomo"
            : "Accesso autonomo configurato · bridge disattivato"
          : "Accesso protetto",
    );
    addStatusItem(grid, "Stato", dirty ? "Modifiche da salvare" : plugin.verification?.message ?? "In attesa");

    const technicalDetails = statusCard.createEl("details", { cls: "bridge-control__technical" });
    technicalDetails.createEl("summary", { text: "Dettagli tecnici" });
    technicalDetails.createEl("small", { text: "File condiviso usato dal bridge:" });
    technicalDetails.createEl("code", { text: plugin.sharedPath, cls: "bridge-control__path" });

    if (plugin.verification && !plugin.verification.ok) {
      statusCard.createEl("p", {
        text: plugin.verification.message,
        cls: "bridge-control__error",
      });
    }
  };

  const renderValidation = (): void => {
    validationEl.empty();
    const validation = validateDraft();
    for (const error of validation.errors) {
      validationEl.createEl("p", { text: error, cls: "bridge-control__error" });
    }
    for (const warning of validation.warnings) {
      validationEl.createEl("p", { text: warning, cls: "bridge-control__warning" });
    }
  };

  const markDirty = (): void => {
    dirty = true;
    renderStatus();
    renderValidation();
  };

  renderStatus();

  let activeToggleComponent!: ToggleComponent;
  let readModeComponent!: DropdownComponent;
  let readFoldersComponent!: TextAreaComponent;
  let writeToggleComponent!: ToggleComponent;
  let writeFoldersComponent!: TextAreaComponent;

  const syncControls = (): void => {
    const protectedMode = draft.accessMode === "protected";
    activeToggleComponent.setValue(draft.enabled);
    readModeComponent.setValue(draft.readMode);
    readModeComponent.selectEl.disabled = !protectedMode;
    readFoldersComponent.setValue(readFoldersRaw);
    readFoldersComponent.inputEl.disabled = !protectedMode || draft.readMode !== "folders";
    writeToggleComponent.setValue(draft.writeEnabled);
    writeToggleComponent.setDisabled(!protectedMode);
    writeFoldersComponent.setValue(writeFoldersRaw);
    writeFoldersComponent.inputEl.disabled = !protectedMode || !draft.writeEnabled;
  };

  const applyFolderSelection = (selection: FolderAccessSelection): void => {
    const readFolders = collapseFolderSelection(selection.readFolders);
    const writeFolders = collapseFolderSelection(selection.writeFolders);
    draft.enabled = true;
    draft.readMode = readFolders.length > 0 ? "folders" : "off";
    draft.readFolders = readFolders;
    draft.writeEnabled = writeFolders.length > 0;
    draft.writeFolders = writeFolders;
    readFoldersRaw = readFolders.join("\n");
    writeFoldersRaw = writeFolders.join("\n");
    syncControls();
    markDirty();
    new Notice("Selezione applicata. Premi Salva accesso per renderla attiva.");
  };

  const openFolderPicker = (): void => {
    const parsedRead = parseFolderList(readFoldersRaw).folders;
    const parsedWrite = parseFolderList(writeFoldersRaw).folders;
    new FolderAccessModal(
      plugin.app,
      {
        readFolders:
          draft.readMode === "folders"
            ? parsedRead
            : draft.writeEnabled
              ? parsedWrite
              : [],
        writeFolders: draft.writeEnabled ? parsedWrite : [],
      },
      applyFolderSelection,
    ).open();
  };

  const saveDraft = async (button: ButtonComponent): Promise<void> => {
    const validation = validateDraft();
    renderValidation();
    if (!validation.settings) {
      new Notice("Correggi i campi evidenziati prima di salvare.");
      return;
    }

    button.setDisabled(true);
    button.setButtonText("Verifica in corso…");
    try {
      await plugin.saveAndVerify(validation.settings);
      dirty = false;
      new Notice("Accesso del bridge salvato e verificato.");
      renderControlPanel(containerEl, plugin, firstRun);
    } catch (error) {
      plugin.verification = {
        ok: false,
        at: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error),
      };
      renderStatus();
      new Notice(`Salvataggio non riuscito: ${plugin.verification.message}`);
    } finally {
      button.setButtonText("Salva accesso");
      button.setDisabled(false);
    }
  };

  containerEl.createEl("h3", { text: "Accesso al vault", cls: "bridge-control__section-title" });

  new Setting(containerEl)
    .setName("Bridge attivo per questo vault")
    .setDesc("Interruttore generale. Se è spento, ChatGPT non può usare questo vault tramite il bridge.")
    .addToggle((toggle) => {
      activeToggleComponent = toggle;
      toggle.setValue(draft.enabled).onChange((value) => {
        draft.enabled = value;
        markDirty();
      });
    });

  const modeCard = containerEl.createDiv({
    cls: `bridge-control__card bridge-control__mode-card ${
      draft.accessMode === "management"
        ? "is-management"
        : draft.accessMode === "full"
          ? "is-full"
          : "is-protected"
    }`,
  });
  const modeTitle = modeCard.createDiv({ cls: "bridge-control__card-title" });
  modeTitle.createEl("h3", {
    text:
      draft.accessMode === "management"
        ? "Gestione completa"
        : draft.accessMode === "full"
          ? "Accesso autonomo"
          : "Accesso protetto",
  });
  modeTitle.createSpan({
    text:
      draft.accessMode === "management"
        ? draft.enabled
          ? "Rischio elevato"
          : "Configurata · bridge spento"
        : draft.accessMode === "full"
          ? draft.enabled
            ? "Autonomo"
            : "Configurato · bridge spento"
          : "Consigliato",
    cls: `bridge-control__badge ${draft.accessMode === "protected" ? "is-ok" : "is-warn"}`,
  });
  modeCard.createEl("p", {
    text:
      draft.accessMode === "management"
        ? draft.enabled
          ? "ChatGPT può creare e aggiungere contenuto e può eseguire soltanto le operazioni di gestione autorizzate qui sotto."
          : "Gestione completa è configurata ma inattiva perché il bridge è spento."
        : draft.accessMode === "full"
          ? draft.enabled
            ? "ChatGPT legge tutto il vault, crea note e aggiunge contenuto autonomamente. Non può modificare, rinominare, spostare o cestinare note."
            : "L'accesso autonomo è configurato ma inattivo perché il bridge è spento."
          : "ChatGPT usa soltanto le cartelle scelte e richiede conferma prima di ogni scrittura.",
  });
  if (draft.accessMode === "management") {
    const permissionSummary = modeCard.createEl("ul", {
      cls: "bridge-control__management-summary",
    });
    permissionSummary.createEl("li", {
      text: `Modifica note e frontmatter: ${draft.managementPermissions.edit ? "sì" : "no"}`,
    });
    permissionSummary.createEl("li", {
      text: `Rinomina e sposta: ${draft.managementPermissions.move ? "sì" : "no"}`,
    });
    permissionSummary.createEl("li", {
      text: `Cestino Obsidian: ${draft.managementPermissions.trash ? "sì" : "no"}`,
    });
  }

  const modeActions = modeCard.createDiv({ cls: "bridge-control__action-buttons" });
  const ensureCleanDraft = (): boolean => {
    if (dirty) {
      new Notice("Prima salva oppure annulla le modifiche ancora in sospeso.");
      return false;
    }
    return true;
  };
  const applyLowerMode = (
    button: HTMLButtonElement,
    accessMode: "protected" | "full",
    successMessage: string,
  ): void => {
    if (!ensureCleanDraft()) return;
    button.disabled = true;
    void plugin.saveAndVerify({
      ...copySettings(plugin.settings),
      accessMode,
      managementPermissions: disabledManagementPermissions(),
    }).then(() => {
      new Notice(successMessage);
      renderControlPanel(containerEl, plugin, firstRun);
    }).catch((error: unknown) => {
      renderControlPanel(containerEl, plugin, firstRun);
      new Notice(
        `Cambio modalità non riuscito: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };
  const openAutonomousConfirmation = (): void => {
    if (!ensureCleanDraft()) return;
    new AutonomousAccessConfirmationModal(
      plugin.app,
      plugin.app.vault.getName(),
      async () => {
        await plugin.saveAndVerify(
          {
            ...copySettings(plugin.settings),
            enabled: true,
            accessMode: "full",
            managementPermissions: disabledManagementPermissions(),
          },
          { fullAccessConfirmed: true },
        );
      },
      () => {
        renderControlPanel(containerEl, plugin, firstRun);
        new Notice("Accesso autonomo attivato e verificato.");
      },
    ).open();
  };
  const openManagementConfirmation = (): void => {
    if (!ensureCleanDraft()) return;
    const initialPermissions = plugin.settings.accessMode === "management"
      ? plugin.settings.managementPermissions
      : disabledManagementPermissions();
    new ManagementAccessConfirmationModal(
      plugin.app,
      plugin.app.vault.getName(),
      initialPermissions,
      async (permissions) => {
        await plugin.saveAndVerify(
          {
            ...copySettings(plugin.settings),
            enabled: true,
            accessMode: "management",
            managementPermissions: { ...permissions },
          },
          { managementPermissionsConfirmed: { ...permissions } },
        );
      },
      () => {
        renderControlPanel(containerEl, plugin, firstRun);
        new Notice("Gestione completa attivata e verificata.");
      },
    ).open();
  };

  if (draft.accessMode === "protected") {
    const autonomousButton = modeActions.createEl("button", {
      text: "Attiva accesso autonomo…",
    });
    autonomousButton.addEventListener("click", openAutonomousConfirmation);
    const managementButton = modeActions.createEl("button", {
      text: "Configura Gestione completa…",
      cls: "mod-warning",
    });
    managementButton.addEventListener("click", openManagementConfirmation);
  } else if (draft.accessMode === "full") {
    const protectedButton = modeActions.createEl("button", {
      text: "Torna ad accesso protetto",
    });
    protectedButton.addEventListener("click", () => {
      applyLowerMode(protectedButton, "protected", "Accesso protetto ripristinato immediatamente.");
    });
    const managementButton = modeActions.createEl("button", {
      text: "Configura Gestione completa…",
      cls: "mod-warning",
    });
    managementButton.addEventListener("click", openManagementConfirmation);
  } else {
    const protectedButton = modeActions.createEl("button", {
      text: "Torna ad accesso protetto",
    });
    protectedButton.addEventListener("click", () => {
      applyLowerMode(protectedButton, "protected", "Accesso protetto ripristinato immediatamente.");
    });
    const autonomousButton = modeActions.createEl("button", {
      text: "Disattiva gestione · mantieni accesso autonomo",
    });
    autonomousButton.addEventListener("click", () => {
      applyLowerMode(autonomousButton, "full", "Permessi di gestione revocati immediatamente.");
    });
    const managementButton = modeActions.createEl("button", {
      text: "Modifica permessi…",
      cls: "mod-warning",
    });
    managementButton.addEventListener("click", openManagementConfirmation);
  }

  const pickerCard = containerEl.createDiv({ cls: "bridge-control__card bridge-control__picker-card" });
  pickerCard.createEl("h3", { text: "Scegli le cartelle" });
  pickerCard.createEl("p", {
    text: "Vedi le cartelle reali del vault e decidi con due spunte quali può leggere e in quali può scrivere ChatGPT.",
  });
  const pickerButton = pickerCard.createEl("button", {
    text: "Scegli cartelle…",
    cls: "mod-cta bridge-control__picker-button",
  });
  pickerButton.addEventListener("click", openFolderPicker);
  pickerButton.disabled = draft.accessMode !== "protected";
  pickerCard.createEl("small", {
    text:
      draft.accessMode !== "protected"
        ? "Le scelte per cartella restano memorizzate e torneranno attive quando ripristini l'accesso protetto."
        : "La scrittura resta controllata: ogni modifica richiede anteprima e conferma in chat.",
  });

  const actionBar = containerEl.createDiv({
    cls: "bridge-control__actions bridge-control__actions--primary",
  });
  const actionCopy = actionBar.createDiv({ cls: "bridge-control__action-copy" });
  actionCopy.createEl("strong", { text: "Rendi attive le scelte" });
  actionCopy.createEl("small", {
    text: "Il selettore prepara le modifiche; salva per renderle attive.",
  });
  const actionButtons = actionBar.createDiv({ cls: "bridge-control__action-buttons" });
  new ButtonComponent(actionButtons)
    .setButtonText("Annulla modifiche")
    .onClick(() => renderControlPanel(containerEl, plugin, firstRun));
  const saveButton = new ButtonComponent(actionButtons).setButtonText("Salva accesso").setCta();
  saveButton.onClick(() => saveDraft(saveButton));

  const problemsCard = containerEl.createDiv({
    cls: "bridge-control__card bridge-control__problems",
  });
  const problemsContent = problemsCard.createDiv({
    cls: "bridge-control__problems-content",
  });
  const renderProblems = (
    diagnostic: AuditDiagnosticsResult | undefined,
    checking = false,
  ): void => {
    problemsContent.empty();
    const title = problemsContent.createDiv({ cls: "bridge-control__card-title" });
    title.createEl("h3", { text: "Problemi recenti" });
    const allFailures = diagnostic?.failedRecords ?? [];
    const failures = allFailures.filter(
      (record) => !plugin.isAuditReviewed(record.changeId),
    );
    const diagnosticUnavailable =
      diagnostic !== undefined &&
      diagnostic.state !== "ready" &&
      diagnostic.state !== "missing";
    const diagnosticPartial =
      diagnostic?.state === "ready" && diagnostic.malformedLines > 0;
    title.createSpan({
      text: checking
        ? "Controllo…"
        : diagnostic === undefined
          ? "Da controllare"
          : diagnosticUnavailable
            ? "Controllo non riuscito"
            : diagnosticPartial
              ? "Registro parziale"
              : diagnostic.state === "missing"
                ? "Nessun registro"
                : failures.length === 0
                  ? "Nessun problema"
                  : `${failures.length} ${failures.length === 1 ? "problema" : "problemi"}`,
      cls: `bridge-control__badge ${
        diagnosticUnavailable || diagnosticPartial
          ? "is-warn"
          : failures.length === 0 ? "is-ok" : "is-warn"
      }`,
    });

    if (checking) {
      problemsContent.createEl("p", {
        text: "Leggo soltanto i metadati locali delle operazioni, senza il contenuto delle note…",
      });
      return;
    }

    if (diagnostic === undefined) {
      problemsContent.createEl("p", {
        text: "Controllo non ancora eseguito.",
      });
      return;
    }
    if (diagnostic.state === "missing") {
      problemsContent.createEl("p", {
        text: "Nessuna operazione di scrittura registrata finora.",
      });
      return;
    }
    if (diagnostic.state !== "ready") {
      problemsContent.createEl("p", {
        text: diagnostic.detail,
        cls: "bridge-control__error",
      });
      return;
    }
    if (failures.length === 0) {
      problemsContent.createEl("p", {
        text:
          allFailures.length === 0
            ? "Nelle operazioni recenti registrate non risultano errori di scrittura."
            : "Tutti i problemi recenti sono stati segnati come controllati.",
      });
    } else {
      const list = problemsContent.createDiv({ cls: "bridge-control__problem-list" });
      for (const record of failures) {
        const item = list.createDiv({
          cls: `bridge-control__problem is-${record.severity}`,
        });
        const heading = item.createDiv({ cls: "bridge-control__problem-heading" });
        heading.createEl("strong", { text: record.summary });
        heading.createEl("time", {
          text: new Date(record.timestamp).toLocaleString("it-IT"),
          attr: { datetime: record.timestamp },
        });
        item.createEl("code", { text: record.path });
        item.createEl("p", { text: record.guidance });

        const existing = plugin.app.vault.getAbstractFileByPath(record.path);
        item.createEl("small", {
          text:
            existing instanceof TFile
              ? "Stato attuale: la nota esiste nel vault."
              : "Stato attuale: la nota non esiste; non risulta un file parziale da aprire.",
        });
        if (existing instanceof TFile) {
          const openButton = item.createEl("button", { text: "Apri nota" });
          openButton.addEventListener("click", () => {
            void plugin.app.workspace
              .getLeaf(false)
              .openFile(existing)
              .catch((error: unknown) => {
                new Notice(
                  `Apertura non riuscita: ${error instanceof Error ? error.message : String(error)}`,
                );
              });
          });
        }
        const reviewedButton = item.createEl("button", {
          text: "Segna come controllato",
        });
        reviewedButton.addEventListener("click", () => {
          reviewedButton.disabled = true;
          void plugin
            .markAuditReviewed(record.changeId)
            .then(() => renderProblems(diagnostic))
            .catch((error: unknown) => {
              reviewedButton.disabled = false;
              new Notice(
                `Salvataggio non riuscito: ${error instanceof Error ? error.message : String(error)}`,
              );
            });
        });

        const technical = item.createEl("details");
        technical.createEl("summary", { text: "Dettagli tecnici" });
        technical.createEl("code", {
          text: [
            record.errorCode ? `Errore: ${record.errorCode}` : undefined,
            record.rollbackReason
              ? `Recupero: ${record.rollbackReason}`
              : undefined,
            record.backupId ? `Backup: ${record.backupId}` : undefined,
            `Modalità: ${record.authorizationMode}`,
          ]
            .filter((value): value is string => value !== undefined)
            .join("\n"),
          cls: "bridge-control__path",
        });
      }
    }
    if (diagnostic.malformedLines > 0) {
      problemsContent.createEl("small", {
        text: `${diagnostic.malformedLines} righe di registro non valide sono state ignorate in sicurezza.`,
        cls: "bridge-control__warning",
      });
    }
    if (diagnostic.truncated) {
      problemsContent.createEl("small", {
        text: "Per sicurezza viene mostrata soltanto la parte più recente del registro.",
      });
    }
  };

  const refreshProblems = async (): Promise<void> => {
    renderProblems(undefined, true);
    try {
      renderProblems(await plugin.refreshAuditDiagnostics());
    } catch (error) {
      problemsContent.empty();
      problemsContent.createEl("p", {
        text: `Controllo non riuscito: ${error instanceof Error ? error.message : String(error)}`,
        cls: "bridge-control__error",
      });
    }
  };

  renderProblems(plugin.auditDiagnostics);
  const problemsActions = problemsCard.createDiv({
    cls: "bridge-control__problem-actions",
  });
  const refreshProblemsButton = problemsActions.createEl("button", {
    text: "Aggiorna controllo",
  });
  refreshProblemsButton.addEventListener("click", () => {
    void refreshProblems();
  });
  if (plugin.auditDiagnostics === undefined && plugin.identity !== undefined) {
    void refreshProblems();
  }

  const advanced = containerEl.createEl("details", { cls: "bridge-control__advanced" });
  advanced.createEl("summary", { text: "Opzioni avanzate di accesso" });
  advanced.createEl("p", {
    text:
      draft.accessMode !== "protected"
        ? "Le scelte per cartella sono conservate ma modificabili solo in Accesso protetto."
        : "Qui puoi usare modalità speciali o modificare manualmente i percorsi relativi al vault.",
    cls: "bridge-control__advanced-intro",
  });

  const readModeSetting = new Setting(advanced)
    .setName("Modalità di lettura")
    .setDesc("“Solo cartelle indicate” è la scelta consigliata.")
    .addDropdown((dropdown) => {
      readModeComponent = dropdown;
      dropdown
        .addOption("off", "Nessuna lettura")
        .addOption("folders", "Solo cartelle indicate")
        .addOption("all", "Tutto il vault")
        .setValue(draft.readMode)
        .onChange((value) => {
          draft.readMode = value as ReadMode;
          readFoldersComponent.inputEl.disabled =
            draft.accessMode !== "protected" || draft.readMode !== "folders";
          markDirty();
        });
      dropdown.selectEl.disabled = draft.accessMode !== "protected";
    });
  readModeSetting.settingEl.addClass("bridge-control__setting");

  const readFoldersSetting = new Setting(advanced)
    .setName("Cartelle leggibili")
    .setDesc("Una cartella per riga, relativa alla radice del vault.")
    .addTextArea((text) => {
      readFoldersComponent = text;
      text
        .setPlaceholder("Progetti\nArchivio")
        .setValue(readFoldersRaw)
        .onChange((value) => {
          readFoldersRaw = value;
          markDirty();
        });
      text.inputEl.disabled = draft.accessMode !== "protected" || draft.readMode !== "folders";
      text.inputEl.rows = 2;
    })
    .addButton((button) =>
      button
        .setButtonText("Scegli…")
        .setDisabled(draft.accessMode !== "protected")
        .onClick(openFolderPicker),
    );
  readFoldersSetting.settingEl.addClasses([
    "bridge-control__setting",
    "bridge-control__setting--stacked",
  ]);

  const writeToggleSetting = new Setting(advanced)
    .setName("Consenti scrittura")
    .setDesc("Resta disattivata finché non scegli volontariamente di abilitarla.")
    .addToggle((toggle) => {
      writeToggleComponent = toggle;
      toggle.setValue(draft.writeEnabled).onChange((value) => {
          draft.writeEnabled = value;
          writeFoldersComponent.inputEl.disabled =
            draft.accessMode !== "protected" || !draft.writeEnabled;
          markDirty();
        });
      toggle.setDisabled(draft.accessMode !== "protected");
    });
  writeToggleSetting.settingEl.addClass("bridge-control__setting");

  const writeFoldersSetting = new Setting(advanced)
    .setName("Cartelle scrivibili")
    .setDesc("Una cartella per riga. La scrittura richiede comunque anteprima e conferma.")
    .addTextArea((text) => {
      writeFoldersComponent = text;
      text
        .setPlaceholder("Progetti")
        .setValue(writeFoldersRaw)
        .onChange((value) => {
          writeFoldersRaw = value;
          markDirty();
        });
      text.inputEl.disabled = draft.accessMode !== "protected" || !draft.writeEnabled;
      text.inputEl.rows = 2;
    })
    .addButton((button) =>
      button
        .setButtonText("Scegli…")
        .setDisabled(draft.accessMode !== "protected")
        .onClick(openFolderPicker),
    );
  writeFoldersSetting.settingEl.addClasses([
    "bridge-control__setting",
    "bridge-control__setting--stacked",
  ]);

  renderValidation();

  const diagnosticDetails = containerEl.createEl("details", { cls: "bridge-control__advanced" });
  diagnosticDetails.createEl("summary", { text: "Diagnostica del collegamento locale" });
  const cliCard = diagnosticDetails.createDiv({ cls: "bridge-control__card bridge-control__cli" });

  const renderCli = (diagnostic: CliDiagnostic | undefined, checking = false): void => {
    cliCard.empty();
    const title = cliCard.createDiv({ cls: "bridge-control__card-title" });
    title.createEl("h3", { text: "Collegamento locale" });
    title.createSpan({
      text: checking
        ? "Controllo…"
        : diagnostic === undefined
          ? "Non eseguita"
          : diagnostic.state === "ready"
            ? "Pronto"
            : diagnostic.state === "error"
              ? "Da completare"
              : "Non trovato",
      cls: `bridge-control__badge ${diagnostic?.state === "ready" ? "is-ok" : "is-warn"}`,
    });

    if (checking) {
      cliCard.createEl("p", { text: "Controllo la CLI soltanto nei percorsi di installazione noti…" });
      return;
    }

    if (diagnostic) {
      cliCard.createEl("p", { text: diagnostic.detail });
      if (diagnostic.executable) {
        cliCard.createEl("code", { text: diagnostic.executable, cls: "bridge-control__path" });
      }
      if (diagnostic.version) {
        cliCard.createEl("small", { text: `Risposta: ${diagnostic.version}` });
      }

      const details = cliCard.createEl("details");
      details.createEl("summary", { text: "Percorsi controllati" });
      const list = details.createEl("ul");
      for (const candidate of diagnostic.candidates) {
        list.createEl("li", {
          text: `${candidate.exists ? "✓" : "–"} ${candidate.path} (${candidate.source})`,
        });
      }
    } else {
      cliCard.createEl("p", { text: "Diagnostica non ancora eseguita." });
    }
  };

  renderCli(plugin.cliDiagnostic);
  new Setting(diagnosticDetails)
    .setName("Controlla la CLI")
    .setDesc("Solo su tua richiesta: non modifica note e non usa la rete; esegue version sui candidati nei percorsi noti.")
    .addButton((button) =>
      button.setButtonText("Esegui diagnostica").onClick(async () => {
        button.setDisabled(true);
        renderCli(undefined, true);
        try {
          renderCli(await plugin.refreshCliDiagnostic());
        } catch (error) {
          renderCli({
            state: "error",
            checkedAt: new Date().toISOString(),
            detail: error instanceof Error ? error.message : String(error),
            candidates: [],
          });
        } finally {
          button.setDisabled(false);
        }
      }),
    );

}

function addStatusItem(container: HTMLElement, label: string, value: string): void {
  const item = container.createDiv({ cls: "bridge-control__status-item" });
  item.createEl("small", { text: `${label}: ` });
  item.createEl("strong", { text: value });
}
