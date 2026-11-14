import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import { IngestionPipeline, type IngestionMetrics } from "../../core/ingestion/pipeline.ts";
import { assertPathContained } from "../../core/resolver/path-resolver.ts";
import { assertUniqueDomainRoots, domainNameKey, domainRootIdentity } from "../../core/config/domain-ownership.ts";
import type { RegisterDomainArgs } from "../schemas.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigLoader } from "../../core/config/loader.ts";
import { SeptumConfigSchema } from "../../core/config/schema.ts";

export type { RegisterDomainArgs } from "../schemas.ts";

export async function handleRegisterDomain(
  repo: SeptumRepository,
  config: ValidatedSeptumConfig,
  args: Partial<RegisterDomainArgs>,
  workspaceRoot: string = process.cwd(),
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  const domainName = (args.domain || args.name || "").trim();
  if (!domainName || !args.root) {
    throw new Error("Missing required arguments: 'domain' (or 'name') and 'root' are required.");
  }

  // SV-02: Enforce workspace containment (reject traversal/absolute/symlink escape)
  assertPathContained(args.root, workspaceRoot, "Domain root");
  signal?.throwIfAborted();

  const domainConfig = {
    root: args.root,
    description: args.description || `Domain: ${domainName}`,
    allowed_dependencies: args.allowed_dependencies,
    forbidden_dependencies: args.forbidden_dependencies,
    archetypes: args.archetypes,
  };

  const proposed = domainRootIdentity(args.root, workspaceRoot);
  const claims = Object.fromEntries(Object.entries(config.domains).filter(([name, claim]) =>
    domainNameKey(name) !== domainNameKey(domainName) && domainRootIdentity(claim.root, workspaceRoot) === proposed));
  assertUniqueDomainRoots({ ...claims, [domainName]: domainConfig }, workspaceRoot);

  const policyFile = join(workspaceRoot, "septum.config.json");
  const policySource = existsSync(policyFile) ? readFileSync(policyFile, "utf8") : undefined;
  if (policySource !== undefined) {
    const policy = SeptumConfigSchema.parse(JSON.parse(policySource));
    const existing = Object.entries(policy.domains).find(([name]) => domainNameKey(name) === domainNameKey(domainName))?.[1];
    domainConfig.allowed_dependencies ??= existing?.allowed_dependencies ?? [];
    domainConfig.forbidden_dependencies ??= existing?.forbidden_dependencies ?? [];
    domainConfig.archetypes ??= existing?.archetypes ?? {};
    domainConfig.description = args.description ?? existing?.description ?? domainConfig.description;
    const claims = Object.fromEntries(Object.entries(policy.domains).filter(([name, claim]) =>
      domainNameKey(name) !== domainNameKey(domainName) && domainRootIdentity(claim.root, workspaceRoot) === proposed));
    assertUniqueDomainRoots({ ...claims, [domainName]: domainConfig }, workspaceRoot);
  }
  const domainId = repo.runInTransaction(() => {
    const id = repo.domains.upsertDomain(domainName, domainConfig, workspaceRoot);
    const stored = repo.domains.getDomainByName(domainName)!;
    if (policySource !== undefined) ConfigLoader.writeDomain(workspaceRoot, stored.name, {
      ...domainConfig,
      allowed_dependencies: JSON.parse(stored.allowed_deps_json),
      forbidden_dependencies: JSON.parse(stored.forbidden_deps_json),
      archetypes: JSON.parse(stored.archetypes_json),
    }, policySource);
    return id;
  }, true);
  const stored = repo.domains.getDomainByName(domainName);
  const canonicalName = stored?.name || domainName;
  const finalConfig = {
    root: stored?.root_path || domainConfig.root,
    description: domainConfig.description,
    allowed_dependencies: stored ? JSON.parse(stored.allowed_deps_json || "[]") : (domainConfig.allowed_dependencies || []),
    forbidden_dependencies: stored ? JSON.parse(stored.forbidden_deps_json || "[]") : (domainConfig.forbidden_dependencies || []),
    archetypes: stored ? JSON.parse(stored.archetypes_json || "{}") : (domainConfig.archetypes || {}),
  };

  config.domains[canonicalName] = finalConfig;

  let ingestionMetrics: IngestionMetrics | null = null;
  if (args.ingest_now) {
    const pipeline = new IngestionPipeline(repo, workspaceRoot);
    ingestionMetrics = await pipeline.run(config, { signal });
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            status: "success",
            policy_owner: policySource === undefined ? "database" : "file",
            message: `Domain '${canonicalName}' successfully registered in ${policySource === undefined ? "SQLite" : "septum.config.json"}.${
              args.ingest_now ? " Initial ingestion completed." : ""
            }`,
            domain_id: domainId,
            domain: canonicalName,
            name: canonicalName,
            config: finalConfig,
            ...(repo.getMeta("sync_error_code") === "DOMAIN_ROOT_CONFLICT" ? {
              index_status: { sync_state: "error", code: "DOMAIN_ROOT_CONFLICT" },
              next: ["Resolve any remaining duplicate roots, then sync before using indexed facts. Registration success only records this policy change."],
            } : {}),
            ...(ingestionMetrics ? { ingestion_metrics: ingestionMetrics } : {}),
          },
          null,
          2
        ),
      },
    ],
  };
}
