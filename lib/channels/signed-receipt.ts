/**
 * SQL receipt capability for the transport that records authenticated message
 * callbacks. Fixed internal aliases only: never interpolate model/user input.
 * Other transports fail closed until their receipt contract is implemented.
 * Scope, CRM message ID, external ID and time checks remain in the caller.
 */
export const SIGNED_MESSAGE_RECEIPT_SQL =
  "w.provider='waha' and w.valid_signature is true " +
  "and w.event_type in ('message','message.any')";
