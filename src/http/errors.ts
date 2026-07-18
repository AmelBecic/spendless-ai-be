// The single error shape every endpoint returns.

/**
 * One field's validation failure. `path` is the dotted location in the request
 * (`"amountCents"`, `"money.currency"`), or `""` for a whole-object rule that
 * belongs to no single field.
 */
export interface FieldError {
  path: string;
  message: string;
}

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    /** Present on validation failures — one entry per offending field. */
    details?: FieldError[];
  };
}

/** An error carrying an HTTP status and a stable machine-readable code. */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: FieldError[];

  constructor(
    statusCode: number,
    code: string,
    message: string,
    options?: { cause?: unknown; details?: FieldError[] },
  ) {
    super(message, options);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = options?.details;
  }
}

/**
 * A 400 that names the offending fields. Thrown before any repository call, so a
 * rejected request never reaches the database.
 */
export class ValidationError extends AppError {
  constructor(details: FieldError[], message = "request failed validation") {
    super(400, "VALIDATION_FAILED", message, { details });
    this.name = "ValidationError";
  }
}
