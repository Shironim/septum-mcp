import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { SeptumRepository } from "../database/repository.ts";
import { IngestionPipeline, type IngestionMetrics } from "../ingestion/pipeline.ts";
import { assertPathContained } from "../resolver/path-resolver.ts";
import { assertUniqueDomainRoots, domainNameKey, domainRootIdentity } from "./domain-ownership.ts";
import type { ValidatedSeptumConfig } from "./schema.ts";
import type { DomainConfig } from "../../types/index.ts";

export interface DomainRegistrationInput {
  domain?: string;
  name?: string;
  root?: string;
  description?: string;
  allowed_dependencies?: string[];
  forbidden_dependencies?: string[];
  archetypes?: Record<string, string>;
  ingest_now?: boolean;
}

export interface DomainRegistrationResult {
  policyOwner: "database";
  domainId: number;
  domain: string;
  config: ValidatedSeptumConfig["domains"][string];
  ingestionMetrics: IngestionMetrics | null;
  conflictPending: boolean;
}

export async function registerDomainPolicy(
  repo: SeptumRepository,
  config: ValidatedSeptumConfig,
  args: DomainRegistrationInput,
  workspaceRoot: string = process.cwd(),
  signal?: AbortSignal
): Promise<DomainRegistrationResult> {
  signal?.throwIfAborted();
  const domainName = (args.domain || args.name || "").trim();
  if (!domainName || !args.root) {
    throw new Error("Missing required arguments: 'domain' (or 'name') and 'root' are required.");
  }

  // SV-02: Enforce workspace containment (reject traversal/absolute/symlink escape)
  assertPathContained(args.root, workspaceRoot, "Domain root");
  const absDomainRoot = resolve(workspaceRoot, args.root);
  try {
    const rootStat = statSync(absDomainRoot);
    if (!rootStat.isDirectory()) {
      throw new Error(`Domain root '${args.root}' is not a directory.`);
    }
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      if (err instanceof Error && err.message.endsWith("is not a directory.")) throw err;
      throw new Error(`Failed to access domain root '${args.root}' for domain '${domainName}': ${err?.message || err}`);
    }
  }
  signal?.throwIfAborted();

  const domainConfig: DomainConfig = {
    root: args.root,
    description: args.description || `Domain: ${domainName}`,
    allowed_dependencies: args.allowed_dependencies,
    forbidden_dependencies: args.forbidden_dependencies,
    archetypes: args.archetypes,
  };

  const proposed = domainRootIdentity(args.root, workspaceRoot);
  const memoryClaims = Object.fromEntries(
    Object.entries(config.domains).filter(
      ([name, claim]) => domainNameKey(name) !== domainNameKey(domainName) && domainRootIdentity(claim.root, workspaceRoot) === proposed
    )
  );
  assertUniqueDomainRoots({ ...memoryClaims, [domainName]: domainConfig }, workspaceRoot);

  const domainId = repo.runInTransaction(() => {
    const id = repo.domains.upsertDomain(domainName, domainConfig, workspaceRoot);
    const stored = repo.domains.getDomainByName(domainName)!;
    repo.rebindFilesToDomain(stored.root_path || domainConfig.root, id);
    return id;
  }, true);

  const stored = repo.domains.getDomainByName(domainName);
  const canonicalName = stored?.name || domainName;
  const finalConfig: ValidatedSeptumConfig["domains"][string] = {
    root: stored?.root_path || domainConfig.root,
    description: domainConfig.description,
    allowed_dependencies: stored ? JSON.parse(stored.allowed_deps_json || "[]") : (domainConfig.allowed_dependencies || []),
    forbidden_dependencies: stored ? JSON.parse(stored.forbidden_deps_json || "[]") : (domainConfig.forbidden_dependencies || []),
    archetypes: stored ? JSON.parse(stored.archetypes_json || "{}") : (domainConfig.archetypes || {}),
  };

  let ingestionMetrics: IngestionMetrics | null = null;
  if (args.ingest_now) {
    const nextConfig: ValidatedSeptumConfig = {
      ...config,
      domains: { ...config.domains, [canonicalName]: finalConfig },
    };
    const pipeline = new IngestionPipeline(repo, workspaceRoot);
    ingestionMetrics = await pipeline.run(nextConfig, { signal });
  }

  return {
    policyOwner: "database",
    domainId,
    domain: canonicalName,
    config: finalConfig,
    ingestionMetrics,
    conflictPending: repo.getMeta("sync_error_code") === "DOMAIN_ROOT_CONFLICT",
  };
}
