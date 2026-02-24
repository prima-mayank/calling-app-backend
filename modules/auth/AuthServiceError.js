export class AuthServiceError extends Error {
  constructor(message, options = {}) {
    super(message || "Auth error");
    this.name = "AuthServiceError";
    this.status = Number.isInteger(options.status) ? options.status : 400;
    this.code = String(options.code || "auth-error");
  }
}
