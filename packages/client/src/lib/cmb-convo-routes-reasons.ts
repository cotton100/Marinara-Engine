/** Localization keys for CMB Convo route states and held deliveries reported by the server. */
export const CMB_CONVO_ROUTE_REASON_KEYS: Record<string, string> = {
  "room-missing": "ui.chat.cmbconvoroutes.reason.roomMissing",
  "room-mode": "ui.chat.cmbconvoroutes.reason.roomMode",
  "member-not-in-room": "ui.chat.cmbconvoroutes.reason.memberNotInRoom",
  "dm-not-private": "ui.chat.cmbconvoroutes.reason.dmNotPrivate",
  "partial-roster": "ui.chat.cmbconvoroutes.reason.partialRoster",
  "native-link-conflict": "ui.chat.cmbconvoroutes.reason.nativeLinkConflict",
  "cmb-unavailable": "ui.chat.cmbconvoroutes.reason.cmbUnavailable",
  "not-registered": "ui.chat.cmbconvoroutes.reason.notRegistered",
  "not-roleplay": "ui.chat.cmbconvoroutes.reason.notRoleplay",
  "ensemble-changed": "ui.chat.cmbconvoroutes.reason.ensembleChanged",
  "invalid-policy": "ui.chat.cmbconvoroutes.reason.invalidPolicy",
  "default-room-unavailable": "ui.chat.cmbconvoroutes.reason.defaultRoomUnavailable",
  "routes-changed": "ui.chat.cmbconvoroutes.reason.routesChanged",
  "speaker-unknown": "ui.chat.cmbconvoroutes.reason.speakerUnknown",
  "speaker-unresolved": "ui.chat.cmbconvoroutes.reason.speakerUnresolved",
  "speaker-mismatch": "ui.chat.cmbconvoroutes.reason.speakerMismatch",
  "speaker-not-member": "ui.chat.cmbconvoroutes.reason.speakerNotMember",
  "speaker-not-in-room": "ui.chat.cmbconvoroutes.reason.speakerNotInRoom",
  "room-unknown": "ui.chat.cmbconvoroutes.reason.roomUnknown",
  "no-default-room": "ui.chat.cmbconvoroutes.reason.noDefaultRoom",
  "not-ensemble-member": "ui.chat.cmbconvoroutes.reason.notEnsembleMember",
  "dm-unavailable": "ui.chat.cmbconvoroutes.reason.dmUnavailable",
  "notes-budget-full": "ui.chat.cmbconvoroutes.reason.notesBudgetFull",
};

export function cmbConvoRouteReasonKey(reason: string): string {
  return CMB_CONVO_ROUTE_REASON_KEYS[reason] ?? "ui.chat.cmbconvoroutes.reason.unknown";
}
