/**
 * Base typed error for Septum domain, validation, and operational failures.
 * Transport layers (MCP / CLI) inspect `code` without ad-hoc property casting.
 */
export class SeptumError extends Error {
  public readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class WorkspaceBusyError extends SeptumError {
  constructor(message: string) {
    super("SERVER_BUSY", message);
  }
}
