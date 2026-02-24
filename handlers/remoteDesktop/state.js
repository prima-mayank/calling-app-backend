export const hosts = new Map();
export const sessions = new Map();
export const pendingRequests = new Map();
export const pendingHostSetupRequests = new Map();
export const hostSetupAssignments = new Map();
export const hostClaims = new Map();

export const REMOTE_REQUEST_TIMEOUT_MS = 45_000;
export const HOST_SETUP_REQUEST_TIMEOUT_MS = 45_000;
export const HOST_SETUP_ASSIGNMENT_TIMEOUT_MS = 15 * 60_000;
