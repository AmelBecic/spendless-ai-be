// The single error shape every endpoint returns.

export interface ErrorBody {
  error: { code: string; message: string };
}

/** An error carrying an HTTP status and a stable machine-readable code. */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
  }
}
