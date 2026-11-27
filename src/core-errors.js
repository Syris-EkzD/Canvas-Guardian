const errors = {
  INVALID_QUERY: [400, "Invalid activity query"],
  INVALID_REQUEST: [400, "Invalid request"],
  UNAUTHENTICATED: [401, "Authentication required"],
  FORBIDDEN: [403, "Access denied"],
  NOT_FOUND: [404, "Route not found"],
  METHOD_NOT_ALLOWED: [405, "Method not allowed"],
  VIEW_CHANGED: [409, "Activity view changed"],
  RATE_LIMITED: [429, "Request budget exceeded"],
  UPSTREAM_INVALID: [502, "Invalid Canvas response"],
  UPSTREAM_FAILED: [502, "Canvas request failed"],
  SERVICE_UNAVAILABLE: [503, "Service unavailable"],
  ACCOUNT_UNVERIFIED: [503, "Account not verified"],
  UPSTREAM_TIMEOUT: [504, "Canvas request timed out"],
  INTERNAL_ERROR: [500, "Internal error"],
};

class CoreError extends Error {
  constructor(code, retryAfter) {
    const [status, message] = errors[code];
    super(message);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

module.exports = { CoreError };
