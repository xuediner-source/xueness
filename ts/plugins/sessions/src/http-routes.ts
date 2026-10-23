/** Successful native route families, also exposed by front-door status. */
export const SESSION_ROUTES = [
  "GET /api/sessions", "POST /api/sessions", "GET /api/sessions/archived",
  "POST /api/sessions/import", "PATCH /api/sessions/:id", "POST /api/sessions/:id/pin",
  "GET /api/sessions/:id/journal", "GET /api/sessions/:id/events.v1",
  "GET /api/sessions/:id/history", "GET /api/sessions/:id/export",
];
export const SESSION_MANAGEMENT_ROUTES = [
  "DELETE /api/sessions/:id", "DELETE /api/sessions/archived/:id", "POST /api/sessions/:id/restore",
];
export const SESSION_LIFECYCLE_ROUTES = [
  "POST /api/sessions/:id/run", "POST /api/sessions/:id/stop", "POST /api/sessions/:id/messages",
  "POST /api/sessions/:id/answer", "POST /api/sessions/:id/approvals",
];
export const SESSION_COMMAND_ROUTES = [
  "POST /api/sessions/commands", "GET /api/sessions/commands/:commandId",
  "POST /api/sessions/:id/commands", "GET /api/sessions/:id/commands/:commandId",
  "GET /api/sessions/:id/queue", "POST /api/sessions/:id/queue", "PATCH /api/sessions/:id/queue",
  "PATCH /api/sessions/:id/queue/:queueId", "DELETE /api/sessions/:id/queue/:queueId",
  "GET /api/sessions/:id/queue-withdrawals", "GET /api/sessions/:id/queue-withdrawals/:recoveryId",
  "DELETE /api/sessions/:id/queue-withdrawals/:recoveryId", "GET /api/sessions/:id/steer",
  "POST /api/sessions/:id/steer", "DELETE /api/sessions/:id/steer/:guidanceId",
  "POST /api/sessions/:id/steer-query", "POST /api/sessions/:id/queue/:queueId/send-now",
];
