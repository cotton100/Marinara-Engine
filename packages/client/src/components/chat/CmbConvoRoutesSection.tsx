import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ApiError } from "../../lib/api-client";
import { cmbConvoRouteReasonKey } from "../../lib/cmb-convo-routes-reasons";
import { cn } from "../../lib/utils";
import { useCmbConvoRoutes, useUpdateCmbConvoRoutes } from "../../hooks/use-cmb-convo-routes";
import { SettingsSwitch } from "../panels/settings/SettingControls";

interface Props {
  chatId: string;
  /** The native 1:1 partner, offered as the first default OOC room when the routes are first enabled. */
  nativeLinkedChatId: string | null;
  chatName: (chatId: string) => string | undefined;
}

/** RP-side control for CMB Convo routes: one ensemble RP ↔ its registered DMs and full-roster groups. */
export function CmbConvoRoutesSection({ chatId, nativeLinkedChatId, chatName }: Props) {
  const { t } = useTranslation();
  const { data: view } = useCmbConvoRoutes(chatId);
  const update = useUpdateCmbConvoRoutes(chatId);

  // Only a registered ensemble RP (or one that already used the routes) shows this block.
  if (!view || (!view.available && view.policy === null)) return null;
  const enabled = view.policy?.enabled === true;
  const revision = view.policy?.revision ?? 0;
  const defaultOocChatId = view.policy?.defaultOocChatId ?? null;
  const reason = (value: string) => t(cmbConvoRouteReasonKey(value), { reason: value });
  const save = (next: { enabled?: boolean; defaultOocChatId?: string | null }) =>
    update.mutate(
      { enabled, defaultOocChatId, expectedRevision: revision, ...next },
      {
        onError: (error) =>
          toast.error(
            error instanceof ApiError && error.message ? error.message : t("ui.chat.cmbconvoroutes.saveFailed"),
          ),
      },
    );
  const candidateIds = new Set(view.defaultOocCandidates.map((room) => room.chatId));
  // A stored default that is no longer a candidate would block turning the routes on, so enabling
  // replaces it. The native partner is only suggested on the first enable or in place of such an
  // invalid room, never over an explicit "no default room".
  const validDefault = defaultOocChatId && candidateIds.has(defaultOocChatId) ? defaultOocChatId : null;
  const suggestNative = view.policy === null || defaultOocChatId !== null;
  const firstDefault =
    validDefault ??
    (suggestNative && nativeLinkedChatId && candidateIds.has(nativeLinkedChatId) ? nativeLinkedChatId : null);
  const statusKey =
    view.state === "active"
      ? "ui.chat.cmbconvoroutes.status.active"
      : view.state === "off" || view.state === "none"
        ? "ui.chat.cmbconvoroutes.status.off"
        : "ui.chat.cmbconvoroutes.status.unavailable";

  return (
    <div className="space-y-2 rounded-lg bg-[var(--secondary)]/50 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-xs font-medium">
          {t("ui.chat.cmbconvoroutes.title", { ensemble: view.ensemble?.name ?? "" })}
        </span>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[0.625rem]",
            view.state === "active"
              ? "bg-[var(--primary)]/15 text-[var(--primary)]"
              : "bg-[var(--accent)] text-[var(--muted-foreground)]",
          )}
        >
          {t(statusKey)}
        </span>
      </div>
      <SettingsSwitch
        label={t("ui.chat.cmbconvoroutes.enable")}
        description={t("ui.chat.cmbconvoroutes.enableDescription")}
        checked={enabled}
        disabled={update.isPending || (!view.available && !enabled)}
        onChange={(next) => save({ enabled: next, ...(next ? { defaultOocChatId: firstDefault } : {}) })}
        labelPosition="start"
        className="min-h-11 justify-between rounded-md bg-[var(--secondary)] px-3 py-2.5 text-left"
        labelClassName="text-xs font-medium"
      />
      {view.stateReason && view.state !== "active" && (
        <p className="text-[0.625rem] leading-relaxed text-amber-700 dark:text-amber-400/80">
          {reason(view.stateReason)}
        </p>
      )}
      {view.available && view.policy && (
        <label className="block space-y-1">
          <span className="text-[0.625rem] text-[var(--muted-foreground)]">
            {t("ui.chat.cmbconvoroutes.defaultOoc")}
          </span>
          <select
            value={defaultOocChatId ?? ""}
            disabled={update.isPending}
            onChange={(event) => save({ defaultOocChatId: event.target.value || null })}
            className="min-h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-2.5 py-2 text-xs text-[var(--foreground)] outline-none transition-colors focus:border-[var(--primary)]/50"
          >
            <option value="">{t("ui.chat.cmbconvoroutes.noDefaultOoc")}</option>
            {defaultOocChatId && !validDefault && (
              // The stored room is shown as it is, so "no default room" stays a real choice that clears it.
              <option value={defaultOocChatId} disabled>
                {t("ui.chat.cmbconvoroutes.defaultOocUnavailable", {
                  room: chatName(defaultOocChatId) ?? defaultOocChatId,
                  reason: reason("default-room-unavailable"),
                })}
              </option>
            )}
            {view.defaultOocCandidates.map((room) => (
              <option key={room.chatId} value={room.chatId}>
                {t(`ui.chat.cmbconvoroutes.roomKind.${room.kind}`, { name: room.name })}
              </option>
            ))}
          </select>
          {view.defaultOocReason && (
            <span className="block text-[0.625rem] text-amber-700 dark:text-amber-400/80">
              {reason(view.defaultOocReason)}
            </span>
          )}
        </label>
      )}
      <ul className="space-y-1 text-[0.625rem] leading-relaxed text-[var(--muted-foreground)]">
        {view.members.map((member) => (
          <li key={member.characterId}>
            {member.dm
              ? t("ui.chat.cmbconvoroutes.memberDm", { character: member.name, room: member.dm.name })
              : t("ui.chat.cmbconvoroutes.memberDmUnavailable", {
                  character: member.name,
                  reason: reason(member.dmReason ?? "room-missing"),
                })}
          </li>
        ))}
        {view.groups.map((room) => (
          <li key={room.chatId}>{t("ui.chat.cmbconvoroutes.groupRoom", { room: room.name })}</li>
        ))}
        {view.excluded
          .filter((room) => room.kind === "group")
          .map((room) => (
            <li key={room.chatId} className="text-amber-700 dark:text-amber-400/80">
              {t("ui.chat.cmbconvoroutes.excludedRoom", {
                room: chatName(room.chatId) ?? room.chatId,
                reason: reason(room.reason),
              })}
            </li>
          ))}
      </ul>
      <p className="text-[0.625rem] leading-relaxed text-[var(--muted-foreground)]">
        {t("ui.chat.cmbconvoroutes.scopeNote")}
      </p>
    </div>
  );
}
