import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import type { MapToolArgs } from "../schemas.ts";
import { handleGetDomainCatalog } from "./get-domain-catalog.ts";
import { handleRegisterDomain } from "./register-domain.ts";

export type { MapToolArgs };

export async function handleMapTool(
  repo: SeptumRepository,
  config: ValidatedSeptumConfig,
  args: MapToolArgs,
  workspaceRoot?: string,
  signal?: AbortSignal
) {
  const action = args.action || "catalog";

  switch (action) {
    case "register":
      return await handleRegisterDomain(repo, config, args, workspaceRoot, signal);

    case "catalog":
    default:
      return handleGetDomainCatalog(repo, config, args, workspaceRoot);
  }
}

// Backward-compatible alias
export const handleDomainTool = handleMapTool;
export type DomainToolArgs = MapToolArgs;
