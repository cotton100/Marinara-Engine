import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api-client";
import { chatKeys } from "./use-chats";

export const cmbConvoRoutesKeys = {
  all: ["cmb-convo-routes"] as const,
  detail: (chatId: string) => [...cmbConvoRoutesKeys.all, chatId] as const,
};

export type CmbConvoRoutesState = "none" | "invalid" | "off" | "unavailable" | "active";

export interface CmbConvoRoutesView {
  state: CmbConvoRoutesState;
  stateReason: string | null;
  available: boolean;
  availabilityReason: string | null;
  ensemble: { id: string; name: string } | null;
  policy: { enabled: boolean; defaultOocChatId: string | null; revision: number } | null;
  defaultOocReason: string | null;
  members: Array<{
    characterId: string;
    name: string;
    dm: { chatId: string; name: string } | null;
    dmReason: string | null;
  }>;
  groups: Array<{ chatId: string; name: string; label: string }>;
  excluded: Array<{ chatId: string; kind: "dm" | "group"; reason: string }>;
  nativePartner: { chatId: string; name: string } | null;
  defaultOocCandidates: Array<{ chatId: string; name: string; kind: "dm" | "group" | "native" }>;
}

export function useCmbConvoRoutes(chatId: string | null, enabled = true) {
  return useQuery({
    queryKey: cmbConvoRoutesKeys.detail(chatId ?? ""),
    queryFn: () => api.get<CmbConvoRoutesView>(`/chats/${chatId}/cmb-routes`),
    enabled: !!chatId && enabled,
    staleTime: 30_000,
  });
}

export function useUpdateCmbConvoRoutes(chatId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { enabled: boolean; defaultOocChatId: string | null; expectedRevision: number }) =>
      api.put<CmbConvoRoutesView>(`/chats/${chatId}/cmb-routes`, input),
    onSuccess: (view) => {
      if (!chatId) return;
      qc.setQueryData(cmbConvoRoutesKeys.detail(chatId), view);
      qc.invalidateQueries({ queryKey: chatKeys.detail(chatId) });
      qc.invalidateQueries({ queryKey: chatKeys.list() });
    },
    onError: () => {
      // A revision conflict means another device changed it; show the current state.
      if (chatId) qc.invalidateQueries({ queryKey: cmbConvoRoutesKeys.detail(chatId) });
    },
  });
}
