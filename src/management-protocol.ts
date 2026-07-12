export const MANAGEMENT_PROTOCOL_VERSION = 1 as const;
export const MAX_MANAGEMENT_REQUEST_BYTES = 1_048_576;

export type ManagementOperation =
  | "replace"
  | "frontmatter"
  | "move"
  | "trash";

export type FrontmatterScalar = string | number | boolean | null;
export type FrontmatterValue =
  | FrontmatterScalar
  | readonly FrontmatterScalar[];

export interface ManagementRequestBase {
  readonly version: typeof MANAGEMENT_PROTOCOL_VERSION;
  readonly request_id: string;
  readonly token: string;
  readonly change_id: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly vault_id: string;
  readonly operation: ManagementOperation;
  readonly path: string;
  readonly before_sha256: string;
}

export interface ReplaceManagementRequest extends ManagementRequestBase {
  readonly operation: "replace";
  readonly payload: {
    readonly content: string;
    readonly after_sha256: string;
  };
}

export interface FrontmatterManagementRequest extends ManagementRequestBase {
  readonly operation: "frontmatter";
  readonly payload: {
    readonly set: Readonly<Record<string, FrontmatterValue>>;
    readonly remove: readonly string[];
  };
}

export interface MoveManagementRequest extends ManagementRequestBase {
  readonly operation: "move";
  readonly payload: { readonly destination: string };
}

export interface TrashManagementRequest extends ManagementRequestBase {
  readonly operation: "trash";
  readonly payload: Readonly<Record<never, never>>;
}

export type ManagementRequest =
  | ReplaceManagementRequest
  | FrontmatterManagementRequest
  | MoveManagementRequest
  | TrashManagementRequest;

export interface ManagementResponse {
  readonly version: typeof MANAGEMENT_PROTOCOL_VERSION;
  readonly request_id: string;
  readonly change_id: string;
  readonly status: "committed" | "failed";
  readonly operation: ManagementOperation;
  readonly path: string;
  readonly target_path?: string | undefined;
  readonly before_sha256: string;
  readonly after_sha256: string;
  readonly verified: boolean;
  readonly backup_id?: string | undefined;
  readonly audit_recorded: boolean;
  readonly error_code?: string | undefined;
  readonly rollback_attempted?: boolean | undefined;
  readonly rollback_succeeded?: boolean | undefined;
  readonly rollback_reason?: string | undefined;
}
