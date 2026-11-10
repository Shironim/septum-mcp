import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import type { IngestionPipeline } from "../../core/ingestion/pipeline.ts";
import type { SymbolToolArgs } from "../schemas.ts";
import { handleLocateSymbol } from "./locate-symbol.ts";
import { handleGetSymbol } from "./get-symbol.ts";
import { handleGetSymbolImpact } from "./get-symbol-impact.ts";
import { retrieveContext } from "../../core/retrieval/context.ts";
import { symbolWorkspace } from "../../core/retrieval/symbol-evidence.ts";

export type { SymbolToolArgs };

export async function handleSymbolTool(
  repo: SeptumRepository,
  config: ValidatedSeptumConfig,
  args: SymbolToolArgs,
  pipeline?: IngestionPipeline,
  workspaceRoot?: string,
  signal?: AbortSignal
) {
  const action = args.action || "locate";

  switch (action) {
    case "context":
    case "inspect": {
      const symbol = args.symbol_ref?.name || args.symbol || args.query || "";
      const candidates = repo.findSymbolsByName(symbol, {
        domain: args.domain, filePath: args.file_path, reference: args.symbol_ref,
      });
      const targetPath = candidates.length === 1 ? candidates[0]!.file_path : args.symbol_ref?.file_path || args.file_path;
      const bounded = args.include_source !== undefined || args.source_start_line !== undefined || args.source_line_limit !== undefined;
      if (!bounded && (!targetPath || /\.(?:ts|mts|cts)$/.test(targetPath))) {
        return retrieveContext(repo, config, args, symbolWorkspace(repo, workspaceRoot || args.workspace_path), signal);
      }
      if (args.continuation !== undefined || args.budget_bytes !== undefined) {
        return { content: [{ type: "text" as const, text: JSON.stringify({
          status: "invalid_context_options",
          message: "budget_bytes and continuation apply to deep TypeScript context. For bounded source use source_start_line and source_line_limit.",
        }) }] };
      }
      return handleGetSymbol(
        repo,
        config,
        {
          symbol,
          query: symbol,
          domain: args.domain,
          file_path: args.file_path,
          symbol_ref: args.symbol_ref,
          include_dependencies: args.include_dependencies,
          include_source: args.include_source ?? true,
          source_start_line: args.source_start_line,
          source_line_limit: args.source_line_limit,
          semantic_depth: args.semantic_depth,
          workspace_path: args.workspace_path,
        },
        workspaceRoot
      );
    }

    case "impact": {
      const symbol = args.symbol || args.query || args.symbol_ref?.name || "";
      return handleGetSymbolImpact(
        repo,
        config,
        {
          symbol,
          query: symbol,
          domain: args.domain,
          file_path: args.file_path,
          symbol_ref: args.symbol_ref,
          workspace_path: args.workspace_path,
        },
        workspaceRoot
      );
    }

    case "locate":
    default:
      return await handleLocateSymbol(
        repo,
        config,
        {
          query: args.query || args.symbol || "",
          domain: args.domain,
          file_path: args.file_path,
          symbol_ref: args.symbol_ref,
          limit: args.limit ?? 10,
          workspace_path: args.workspace_path,
        },
        pipeline,
        workspaceRoot
      );
  }
}
