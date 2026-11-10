/** Presentation only. Backend authorization and API payloads are unchanged. */
export type AuditEvent = {
  id: string;
  eventType: string;
  subjectUserId: string | null;
  subjectName: string | null;
  subjectEmail: string | null;
  details: unknown;
  createdAt: string;
  actorName: string;
  actorEmail: string | null;
  payrollOnly?: boolean;
};

// Account/role events remain readable even when their payload mentions Payroll.
// Unknown/legacy event types are concealed until classified, rather than exposing a new payroll payload.
const administrativeEvents = new Set([
  "access_request_created",
  "access_request_approved",
  "access_request_denied",
  "first_admin_bootstrap",
  "user_access_updated",
  "session_created",
  "logout",
  "notification_settings_updated",
  "notification_test_queued",
]);
export const isAdministrativeAuditEvent = (eventType: string) =>
  administrativeEvents.has(eventType);

export function presentAuditEvent(
  event: AuditEvent,
  canViewPayroll: boolean,
): AuditEvent {
  if (canViewPayroll || isAdministrativeAuditEvent(event.eventType))
    return event;
  return {
    id: event.id,
    createdAt: event.createdAt,
    payrollOnly: true,
    eventType: "",
    actorName: "",
    actorEmail: null,
    subjectUserId: null,
    subjectName: null,
    subjectEmail: null,
    details: null,
  };
}
