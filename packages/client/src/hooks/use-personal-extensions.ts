import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreatePersonalExtensionInput,
  PersonalClientExtensionRuntime,
  PersonalExtension,
  PersonalExtensionPolicy,
  UpdatePersonalExtensionInput,
} from "@marinara-engine/shared";
import { ApiError, api } from "../lib/api-client";

export const personalExtensionKeys = {
  all: ["personal-extensions"] as const,
  list: () => [...personalExtensionKeys.all, "list"] as const,
  runtime: () => [...personalExtensionKeys.all, "runtime"] as const,
  policy: () => [...personalExtensionKeys.all, "policy"] as const,
};

export function usePersonalExtensions() {
  return useQuery({
    queryKey: personalExtensionKeys.list(),
    queryFn: ({ signal }) => api.get<PersonalExtension[]>("/personal-extensions", { signal }),
    staleTime: 30_000,
  });
}

export function usePersonalExtensionRuntime() {
  return useQuery({
    queryKey: personalExtensionKeys.runtime(),
    queryFn: ({ signal }) =>
      api.get<PersonalClientExtensionRuntime[]>("/personal-extensions/runtime/client", { signal }),
    staleTime: 30_000,
    // Mobile can foreground before its VPN route is ready. Retry transient
    // startup failures for a bounded window, but never turn a bad key or
    // another client error into permanent background traffic.
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.status >= 400 && error.status < 500) && failureCount < 4,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 5_000),
    refetchOnMount: "always",
    refetchOnReconnect: "always",
    refetchOnWindowFocus: "always",
  });
}

export function usePersonalExtensionPolicy() {
  return useQuery({
    queryKey: personalExtensionKeys.policy(),
    queryFn: ({ signal }) => api.get<PersonalExtensionPolicy>("/personal-extensions/policy", { signal }),
    staleTime: 30_000,
  });
}

export function useSetExternalExtensionsEnabled() {
  const invalidate = useInvalidatePersonalExtensions();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      api.patch<PersonalExtensionPolicy>("/personal-extensions/policy/external", { enabled }),
    onSuccess: invalidate,
  });
}

function useInvalidatePersonalExtensions() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: personalExtensionKeys.all });
}

export function useCreatePersonalExtension() {
  const invalidate = useInvalidatePersonalExtensions();
  return useMutation({
    mutationFn: (input: CreatePersonalExtensionInput) => api.post<PersonalExtension>("/personal-extensions", input),
    onSuccess: invalidate,
  });
}

export function useUpdatePersonalExtension() {
  const invalidate = useInvalidatePersonalExtensions();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & UpdatePersonalExtensionInput) =>
      api.patch<PersonalExtension>(`/personal-extensions/${id}`, input),
    onSuccess: invalidate,
  });
}

export function useApprovePersonalExtension() {
  const invalidate = useInvalidatePersonalExtensions();
  return useMutation({
    mutationFn: ({
      id,
      contentHash,
      acknowledgeFullPageAccess,
    }: {
      id: string;
      contentHash: string;
      acknowledgeFullPageAccess?: boolean;
    }) =>
      api.post<PersonalExtension>(`/personal-extensions/${id}/approve`, {
        contentHash,
        acknowledgeSandboxedCode: true,
        ...(acknowledgeFullPageAccess ? { acknowledgeFullPageAccess: true } : {}),
      }),
    onSuccess: invalidate,
  });
}

export function useRollbackPersonalExtension() {
  const invalidate = useInvalidatePersonalExtensions();
  return useMutation({
    mutationFn: ({ id, contentHash }: { id: string; contentHash: string }) =>
      api.post<PersonalExtension>(`/personal-extensions/${id}/rollback`, { contentHash }),
    onSuccess: invalidate,
  });
}

export function useDeletePersonalExtension() {
  const invalidate = useInvalidatePersonalExtensions();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/personal-extensions/${id}`),
    onSuccess: invalidate,
  });
}
