import { discoverDeclarativeRoutesFromFiles, type DiscoveredRoute } from "../discovery/declarative-routes.ts";
import { readOptionalSourceFile } from "../resources/source-files.ts";
import { ImportCandidateResolver } from "./import-candidates.ts";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import type {
  ExecutionChainNode,
  FileRecord,
  SymbolRecord,
  VerticalSliceRecord,
} from "../../types/index.ts";
import type { SeptumRepository } from "../database/repository.ts";
import { detectPipelineStage, extractImportedSymbolNames as extractImportedNames } from "./call-graph-helpers.ts";
import { traverseAstMethodGraph } from "./ast-method-tracer.ts";
import { traversePolyglotMethodDependencies } from "./polyglot-slice-tracer.ts";

export type { DiscoveredRoute };

export class CallGraphTracer {
  private fileMapByNormPath: Map<string, FileRecord> = new Map();
  private fileMapById: Map<number, FileRecord> = new Map();
  private symbolsByFileId: Map<number, SymbolRecord[]> = new Map();
  private dependenciesByFileId: Map<
    number,
    Array<{ target: string; statement: string; line_number: number; is_external: boolean }>
  > = new Map();

  private readonly importCandidates: ImportCandidateResolver;

  constructor(private repo: SeptumRepository, private projectRoot: string = process.cwd()) {
    this.importCandidates = new ImportCandidateResolver(repo, projectRoot, this.fileMapByNormPath, path => this.fileForPath(path));
  }

  private fileForPath(path: string): FileRecord | undefined {
    const key = this.normalizeFilePath(path);
    const cached = this.fileMapByNormPath.get(key);
    if (cached) return cached;
    const file = this.repo.getFileByPath(path.replace(/\\/g, "/").replace(/^\.\//, ""));
    if (!file) return undefined;
    this.fileMapByNormPath.set(key, file);
    this.fileMapById.set(file.id, file);
    return file;
  }

  private fileSymbols(fileId: number): SymbolRecord[] {
    if (!this.symbolsByFileId.has(fileId)) this.symbolsByFileId.set(fileId, this.repo.getSymbolsByFileId(fileId));
    return this.symbolsByFileId.get(fileId)!;
  }

  private fileDependencies(fileId: number) {
    if (!this.dependenciesByFileId.has(fileId)) this.dependenciesByFileId.set(fileId, this.repo.getDependenciesByFileId(fileId));
    return this.dependenciesByFileId.get(fileId)!;
  }

  /**
   * Initializes internal fast lookup maps from SQLite repository data.
   */
  public initMaps(): void {
    this.fileMapByNormPath.clear(); this.fileMapById.clear();
    this.symbolsByFileId.clear(); this.dependenciesByFileId.clear();
    const allSymbolsWithFiles = this.repo.getAllSymbolsWithFiles();
    const allDeps = this.repo.getAllDependenciesWithDomains();
    this.importCandidates.reset();

    // Map files
    const allFiles = this.repo.getAllFiles();
    for (const f of allFiles) {
      const norm = this.normalizeFilePath(f.path);
      this.fileMapByNormPath.set(norm, f);
      this.fileMapById.set(f.id, f);
    }

    // Map symbols
    for (const s of allSymbolsWithFiles) {
      const existing = this.symbolsByFileId.get(s.file_id) || [];
      existing.push(s);
      this.symbolsByFileId.set(s.file_id, existing);
    }

    // Map dependencies
    for (const d of allDeps) {
      const file = this.fileMapByNormPath.get(this.normalizeFilePath(d.source_file));
      if (file) {
        const existing = this.dependenciesByFileId.get(file.id) || [];
        existing.push({
          target: d.target,
          statement: d.statement,
          line_number: d.line_number,
          is_external: d.is_external,
        });
        this.dependenciesByFileId.set(file.id, existing);
      }
    }
  }

  /** Legacy route modules sometimes receive their router as an ambient global. */
  public discoverDeclarativeRoutes(excluded?: ReadonlySet<string>): DiscoveredRoute[] {
    return discoverDeclarativeRoutesFromFiles(this.projectRoot, this.fileMapByNormPath, excluded);
  }

  public traceAllSlices(maxDepth = 5, options: { includeInferredControllers?: boolean; excludeEntrypointFiles?: ReadonlySet<string> } = {}): Array<Omit<VerticalSliceRecord, "id" | "created_at">> {
    const effectiveMaxDepth = Math.min(Math.max(Math.trunc(maxDepth || 5), 1), 8);
    this.initMaps();
    const coveredFiles = options.excludeEntrypointFiles;
    const slices = this.discoverDeclarativeRoutes(coveredFiles).map(route => {
      const chain = this.traceChainFromRoute(route, effectiveMaxDepth);
      chain[0].relationship = { kind: "route_binding", derivation: "inferred", reason: "ambient_router_convention" };
      return this.buildSliceRecordFromChain(route.method, route.uri, chain, "clean");
    });
    if (options.includeInferredControllers === false) return slices;
    // 2. Trace controllers if routes were not explicitly bound or found
    for (const [normPath, file] of this.fileMapByNormPath.entries()) {
      const isController =
        file.archetype === "controller" ||
        /controller/i.test(normPath) ||
        normPath.endsWith("Controller.ts") ||
        normPath.endsWith("Controller.js");

      if (!isController || coveredFiles?.has(file.path)) continue;

      const symbols = this.fileSymbols(file.id);
      const methods = symbols.filter((s) => s.kind === "method" || s.kind === "function");

      for (const m of methods) {
        const action = m.name.split("::").at(-1)!;
        // Skip constructors or private helpers
        if (action === "constructor" || action.startsWith("_")) continue;

        // Check if this method was already covered by declarative routes
        const alreadyCovered = slices.some(
          (s) =>
            s.controller_file === file.path &&
            s.action_name.toLowerCase() === action.toLowerCase()
        );
        if (alreadyCovered) continue;

        const chain = this.traceChainFromController(file, m, effectiveMaxDepth);
        if (chain.length > 0) {
          const defaultMethod = /create|store|save|add/i.test(action)
            ? "POST"
            : /update|edit|patch/i.test(action)
            ? "PUT"
            : /delete|remove|destroy/i.test(action)
            ? "DELETE"
            : "GET";

          const inferredUri = this.inferRouteUri(file.path, action);
          const sliceRecord = this.buildSliceRecordFromChain(
            defaultMethod,
            inferredUri,
            chain,
            "clean"
          );
          slices.push(sliceRecord);
        }
      }
    }

    return slices;
  }

  /**
   * Trace execution chain starting from a declarative route.
   */
  public traceChainFromRoute(route: DiscoveredRoute, maxDepth: number = 5): ExecutionChainNode[] {
    const effectiveMaxDepth = Math.min(Math.max(Math.trunc(maxDepth || 5), 1), 8);
    const chain: ExecutionChainNode[] = [];

    // Stage 1: Ingress
    chain.push({
      stage: "ingress",
      symbol: `${route.method} ${route.uri}`,
      file: route.file,
      line: route.line,
      description: `HTTP Route Ingress: ${route.method} ${route.uri}`,
    });

    // Stage 2: Validation / Middleware
    for (const mw of route.middlewareSymbols) {
      const mwLoc = this.locateSymbol(mw, route.file);
      chain.push({
        stage: "validation",
        symbol: mw,
        file: mwLoc?.file,
        line: mwLoc?.line,
        description: `Request Validation / Middleware: ${mw}`,
      });
    }

    // Stage 3: Controller / Handler
    let controllerFile: FileRecord | undefined;
    let actionMethod = route.handlerMethod || route.handlerSymbol || "handle";

    if (route.handlerClass) {
      const found = this.findFileBySymbolOrName(route.handlerClass, route.file);
      if (found) {
        controllerFile = found.file;
        if (!route.handlerMethod && found.symbol) {
          actionMethod = found.symbol.name;
        }
      }
    } else if (route.handlerSymbol) {
      const found = this.findFileBySymbolOrName(route.handlerSymbol, route.file);
      if (found) {
        controllerFile = found.file;
      }
    }

    if (controllerFile) {
      const syms = this.fileSymbols(controllerFile.id);
      const methodSym = syms.find(
        (s) => s.name.toLowerCase() === actionMethod.toLowerCase()
      );

      const ctrlName =
        syms.find((s) => s.kind === "class")?.name ||
        controllerFile.path.split("/").pop()?.replace(/\.[^.]+$/, "") ||
        "Controller";

      chain.push({
        stage: "controller",
        symbol: `${ctrlName}::${actionMethod}`,
        file: controllerFile.path,
        line: methodSym?.line_start || 1,
        description: `Controller Action: ${ctrlName}::${actionMethod}`,
      });

      // Forward reachability BFS from controller
      this.traverseOutboundDependencies(controllerFile, chain, effectiveMaxDepth);
    }

    return chain;
  }

  public static readonly MAX_CHAIN_NODES = 25;

  /**
   * Trace execution chain starting from a controller method.
   */
  public traceChainFromController(
    controllerFile: FileRecord,
    method: SymbolRecord,
    maxDepth: number = 5
  ): ExecutionChainNode[] {
    const effectiveMaxDepth = Math.min(Math.max(Math.trunc(maxDepth || 5), 1), 8);
    const chain: ExecutionChainNode[] = [];
    const syms = this.fileSymbols(controllerFile.id);
    const parts = method.name.split("::");
    const action = parts.pop()!;
    const ctrlName = parts.pop() ||
      syms.find((s) => s.kind === "class")?.name ||
      controllerFile.path.split("/").pop()?.replace(/\.[^.]+$/, "") ||
      "Controller";

    // Stage 1: Ingress (inferred)
    const inferredUri = this.inferRouteUri(controllerFile.path, action);
    const defaultMethod = /create|store|save|add/i.test(action)
      ? "POST"
      : /update|edit|patch/i.test(action)
      ? "PUT"
      : /delete|remove|destroy/i.test(action)
      ? "DELETE"
      : "GET";

    chain.push({
      stage: "ingress",
      symbol: `${defaultMethod} ${inferredUri}`,
      file: controllerFile.path,
      line: method.line_start,
      relationship: { kind: "route_binding", derivation: "inferred", reason: "controller_convention" },
      description: `Inferred Ingress: ${defaultMethod} ${inferredUri}`,
    });

    // Stage 3: Controller
    chain.push({
      stage: "controller",
      symbol: `${ctrlName}::${action}`,
      file: controllerFile.path,
      line: method.line_start,
      description: `Controller Action: ${ctrlName}::${action}`,
    });

    // Forward reachability BFS
    this.traverseOutboundDependencies(controllerFile, chain, effectiveMaxDepth);

    return chain;
  }

  /**
   * Expand an existing slice execution chain starting from controllerFilePath up to maxDepth.
   */
  public expandChainFromFile(
    controllerFilePath: string,
    existingChain: ExecutionChainNode[],
    maxDepth: number = 5
  ): ExecutionChainNode[] {
    const effectiveMaxDepth = Math.min(Math.max(Math.trunc(maxDepth || 5), 1), 8);
    const startFile = this.fileForPath(controllerFilePath);
    if (!startFile) {
      return existingChain.slice(0, CallGraphTracer.MAX_CHAIN_NODES);
    }

    const chain = [...existingChain];
    this.traverseOutboundDependencies(startFile, chain, effectiveMaxDepth);
    return chain;
  }

  /**
   * AST-scoped Call Tracing: Only expands dependencies referenced inside the specific target method body & signature.
   * Completely filters out unused file-level imports to prevent context bloat and cognitive noise.
   */
  public expandChainFromMethod(
    controllerFilePath: string,
    actionName: string,
    existingChain: ExecutionChainNode[],
    maxDepth: number = 5
  ): ExecutionChainNode[] {
    const effectiveMaxDepth = Math.min(Math.max(Math.trunc(maxDepth || 5), 1), 8);
    const startFile = this.fileForPath(controllerFilePath);
    if (!startFile) {
      return existingChain.slice(0, CallGraphTracer.MAX_CHAIN_NODES);
    }

    const symbols = this.fileSymbols(startFile.id);
    const candidates = symbols.filter(
      (s) => (s.kind === "method" || s.kind === "function") && (s.name.endsWith(`::${actionName}`) || s.name.endsWith(`@${actionName}`) || s.name === actionName)
    );

    const line = existingChain.find(node => node.stage === "controller" && node.file === controllerFilePath)?.line;
    const matches = line ? candidates.filter(s => s.line_start <= line && line <= s.line_end) : [];
    if (candidates.length > 1 && matches.length !== 1) return existingChain;
    const methodSymbol = matches[0] ?? candidates[0];
    if (!methodSymbol) {
      return this.expandChainFromFile(controllerFilePath, existingChain, maxDepth);
    }

    const fullPath = resolve(this.projectRoot, startFile.path);
    if (!existsSync(fullPath)) {
      return existingChain.slice(0, CallGraphTracer.MAX_CHAIN_NODES);
    }

    let methodBody = "";
    try {
      const fileContent = readOptionalSourceFile(fullPath, "utf-8");
      const lines = fileContent.split(/\r?\n/);
      const start = Math.max(0, methodSymbol.line_start - 1);
      const end = Math.min(lines.length, methodSymbol.line_end);
      const owner = symbols.find(s => s.kind === "class" && s.line_start <= methodSymbol.line_start && s.line_end >= methodSymbol.line_end);
      const ownerSource = owner ? lines.slice(owner.line_start - 1, owner.line_end).join("\n") : fileContent;
      methodBody = this.scopeWithInjectedTypes(ownerSource, lines.slice(start, end).join("\n"));
    } catch {
      return this.expandChainFromFile(controllerFilePath, existingChain, maxDepth);
    }

    const chain = [...existingChain];
    // Method-scoped vertical slices stop at 1-hop direct collaborators (Option A).
    this.traverseMethodScopedDependencies(startFile, methodBody, methodSymbol, chain, 1);
    return chain;
  }

  private extractScopeForCollaborator(
    collaboratorFile: FileRecord,
    callerScopeText: string
  ): string {
    const symbols = this.fileSymbols(collaboratorFile.id);
    const methods = symbols.filter((s) => s.kind === "method" || s.kind === "function");
    if (methods.length === 0) return "";

    // Find methods whose short name is referenced in callerScopeText
    let matchedMethods = methods.filter((m) => {
      const shortName = m.name.split("::").pop() || "";
      return shortName.length > 2 && callerScopeText.includes(shortName);
    });

    // If no direct method name match, check for standard action execution methods: execute / handle
    if (matchedMethods.length === 0) {
      if (callerScopeText.includes("execute") || callerScopeText.includes("handle")) {
        matchedMethods = methods.filter((m) => {
          const shortName = m.name.split("::").pop() || "";
          return shortName === "execute" || shortName === "handle";
        });
      }
    }

    if (matchedMethods.length === 0) return "";

    const fullPath = resolve(this.projectRoot, collaboratorFile.path);
    if (!existsSync(fullPath)) return "";

    try {
      const fileContent = readOptionalSourceFile(fullPath, "utf-8");
      const lines = fileContent.split(/\r?\n/);
      let scope = "";
      for (const m of matchedMethods) {
        const start = Math.max(0, m.line_start - 1);
        const end = Math.min(lines.length, m.line_end);
        scope += (m.signature || "") + "\n" + lines.slice(start, end).join("\n") + "\n";
      }
      return this.scopeWithInjectedTypes(fileContent, scope);
    } catch {
      return "";
    }
  }

  /** Static hints for explicitly typed properties used by this scope. */
  private scopeWithInjectedTypes(source: string, scope: string): string {
    const types = new Set<string>();
    for (const match of scope.matchAll(/(?:\bthis\.([A-Za-z_]\w*)|\$this->([A-Za-z_]\w*))/g)) {
      const property = match[1] ?? match[2]!;
      const tsType = new RegExp(`\\b${property}\\s*[?!]?\\s*:\\s*([A-Za-z_]\\w*)\\b`, "g");
      const phpType = new RegExp(`\\b(?:public|protected|private)\\s+(?:readonly\\s+)?([\\\\A-Za-z_]\\w*(?:\\\\\\w+)*)\\s+\\$${property}\\b`, "g");
      for (const declaration of source.matchAll(tsType)) types.add(declaration[1]!);
      for (const declaration of source.matchAll(phpType)) types.add(declaration[1]!.split("\\").pop()!);
    }
    return scope + "\n" + [...types].join("\n");
  }

  private isExecutableSymbol(s: SymbolRecord): boolean {
    if (
      s.kind === "class" ||
      s.kind === "function" ||
      s.kind === "method" ||
      s.kind === "struct" ||
      s.kind === "trait" ||
      s.kind === "component" ||
      s.kind === "view"
    ) {
      return true;
    }
    if (
      s.kind === "interface" ||
      s.kind === "type" ||
      s.kind === "property" ||
      s.kind === "constant" ||
      s.kind === "enum"
    ) {
      return false;
    }
    if (s.kind === "variable") {
      if (/^[A-Z0-9_]{3,}$/.test(s.name)) return false;
      if (/(?:Schema|Config|Options|Settings|Params)$/i.test(s.name)) return false;
      return true;
    }
    return false;
  }

  private resolveExecutableSymbol(
    fileSymbols: SymbolRecord[],
    importedNames: string[]
  ): SymbolRecord | undefined {
    if (importedNames.length > 0) {
      const matched = fileSymbols.find((s) => importedNames.includes(s.name) && this.isExecutableSymbol(s));
      if (matched) return matched;

      // If imported symbols match in this file but none are executable (e.g. types/constants),
      // then this import was solely for non-executable definitions.
      const nonExecutableMatched = fileSymbols.some((s) => importedNames.includes(s.name));
      if (nonExecutableMatched) {
        return undefined;
      }
    }

    const executable = fileSymbols.filter((s) => this.isExecutableSymbol(s));
    return (
      executable.find((s) => s.kind === "class" || s.kind === "struct") ||
      executable.find((s) => s.kind === "function" || s.kind === "method") ||
      executable[0]
    );
  }

  public traverseMethodScopedDependencies(
    startFile: FileRecord,
    methodBody: string,
    methodSymbol: SymbolRecord,
    chain: ExecutionChainNode[],
    maxDepth: number = 5
  ): void {
    const effectiveMaxDepth = Math.min(Math.max(Math.trunc(maxDepth || 5), 1), 8);
    const hasWorkspaceRoot = Boolean(this.repo.getMeta?.("workspace_root"));
    if (/\.[cm]?[jt]sx?$/i.test(startFile.path)) {
      traverseAstMethodGraph(
        {
          projectRoot: this.projectRoot,
          maxChainNodes: CallGraphTracer.MAX_CHAIN_NODES,
          hasWorkspaceRoot,
          fileSymbols: (fileId) => this.fileSymbols(fileId),
          fileDependencies: (fileId) => this.fileDependencies(fileId),
          resolveImportTargets: (from, spec) => this.resolveImportTargets(from, spec),
          resolveImportToFile: (from, spec) => this.resolveImportToFile(from, spec),
          resolveExecutableSymbol: (symbols, names) => this.resolveExecutableSymbol(symbols, names),
          isExecutableSymbol: (symbol) => this.isExecutableSymbol(symbol),
          detectStage: (filePath, archetype) => this.detectStage(filePath, archetype),
        },
        startFile,
        methodSymbol,
        chain,
        effectiveMaxDepth
      );
      return;
    }

    traversePolyglotMethodDependencies(
      {
        projectRoot: this.projectRoot,
        maxChainNodes: CallGraphTracer.MAX_CHAIN_NODES,
        hasWorkspaceRoot,
        fileSymbols: (fileId) => this.fileSymbols(fileId),
        fileDependencies: (fileId) => this.fileDependencies(fileId),
        extractImportedSymbolNames: (stmt) => this.extractImportedSymbolNames(stmt),
        resolveImportTargets: (from, target) => this.resolveImportTargets(from, target),
        resolveImportToFile: (from, target) => this.resolveImportToFile(from, target),
        resolveExecutableSymbol: (symbols, names) => this.resolveExecutableSymbol(symbols, names),
        isExecutableSymbol: (symbol) => this.isExecutableSymbol(symbol),
        detectStage: (filePath, archetype) => this.detectStage(filePath, archetype),
      },
      startFile,
      methodBody,
      methodSymbol,
      chain
    );
  }

  /**
   * Traverse outbound dependencies using BFS with cycle detection, max hop limit, and node ceiling.
   */
  public traverseOutboundDependencies(
    startFile: FileRecord,
    chain: ExecutionChainNode[],
    maxDepth: number = 5
  ): void {
    const effectiveMaxDepth = Math.min(Math.max(Math.trunc(maxDepth || 5), 1), 8);
    const visitedFiles = new Set<string>();
    visitedFiles.add(startFile.path);
    const queue: Array<{ file: FileRecord; depth: number }> = [
      { file: startFile, depth: 1 },
    ];

    while (queue.length > 0 && chain.length < CallGraphTracer.MAX_CHAIN_NODES) {
      const current = queue.shift()!;
      if (current.depth > effectiveMaxDepth) break;

      const deps = this.fileDependencies(current.file.id);

      for (const dep of deps) {
        if (/^\s*(?:import|export)\s+type\b/.test(dep.statement)) continue;
        if (chain.length >= CallGraphTracer.MAX_CHAIN_NODES) break;
        const resolvedFiles = this.repo.getMeta?.("workspace_root") ? this.resolveImportTargets(current.file.path, dep.target)
          : dep.is_external ? [] : [this.resolveImportToFile(current.file.path, dep.target)].filter((file): file is FileRecord => !!file);
        for (const resolvedFile of resolvedFiles) {
        if (!resolvedFile || visitedFiles.has(resolvedFile.path)) continue;

        visitedFiles.add(resolvedFile.path);

        const stage = this.detectStage(resolvedFile.path, resolvedFile.archetype);
        const fileSymbols = this.fileSymbols(resolvedFile.id);
        const importedNames = this.extractImportedSymbolNames(dep.statement);
        const mainSymbol = this.resolveExecutableSymbol(fileSymbols, importedNames);
        if (!mainSymbol) {
          continue;
        }

        const symbolDisplay = mainSymbol.name;

        // Prevent adding duplicate stages if already present, or add as refinement
        const existingStageNode = chain.find(
          (c) => c.stage === stage && c.file === resolvedFile.path
        );

        if (!existingStageNode) {
          chain.push({
            stage,
            symbol: symbolDisplay,
            file: resolvedFile.path,
            line: mainSymbol.line_start || 1,
            description: `${stage.toUpperCase()} (dependency, not a proven call): ${symbolDisplay}`,
            relationship: { kind: "imports", derivation: "source", source: { file: current.file.path, line: dep.line_number, statement: dep.statement }, reason: "static import; stage classification is inferred" },
          });
        }

        queue.push({ file: resolvedFile, depth: current.depth + 1 });
        }
      }
    }

    // Sort stages according to standard pipeline order
    const stageOrder: Record<string, number> = {
      ingress: 1,
      validation: 2,
      controller: 3,
      orchestrator: 3,
      use_case: 4,
      service: 4,
      domain: 5,
      entity: 5,
      egress: 6,
      repository: 6,
    };

    chain.sort((a, b) => {
      const orderA = stageOrder[a.stage] || 99;
      const orderB = stageOrder[b.stage] || 99;
      return orderA - orderB;
    });

    if (chain.length > CallGraphTracer.MAX_CHAIN_NODES) {
      chain.length = CallGraphTracer.MAX_CHAIN_NODES;
    }
  }

  private extractImportedSymbolNames(statement: string): string[] {
    return extractImportedNames(statement);
  }

  /**
   * Detect generic pipeline stage from file path and archetype.
   */
  public detectStage(filePath: string, archetype: string): string {
    return detectPipelineStage(filePath, archetype);
  }

  public resolveImportTargets(sourceFilePath: string, importTarget: string): FileRecord[] {
    return this.importCandidates.resolveImportTargets(sourceFilePath, importTarget);
  }

  public resolveImportToFile(sourceFilePath: string, importTarget: string): FileRecord | undefined {
    return this.importCandidates.resolveImportToFile(sourceFilePath, importTarget);
  }

  /**
   * Locate a symbol in the codebase or relative to a file.
   */
  private locateSymbol(
    symbolName: string,
    relativeToFile?: string
  ): { file: string; line: number } | null {
    const cleanSymbol = symbolName.replace(/[()]/g, "").trim();

    // Check imports of relativeToFile first
    if (relativeToFile) {
      const file = this.fileMapByNormPath.get(this.normalizeFilePath(relativeToFile));
      if (file) {
        const deps = this.fileDependencies(file.id);
        for (const dep of deps) {
          if (dep.target.includes(cleanSymbol) || dep.statement.includes(cleanSymbol)) {
            const targetFile = this.resolveImportToFile(relativeToFile, dep.target);
            if (targetFile) {
              const syms = this.fileSymbols(targetFile.id);
              const s = syms.find((sym) => sym.name === cleanSymbol);
              return {
                file: targetFile.path,
                line: s?.line_start || 1,
              };
            }
          }
        }
      }
    }

    // Global symbol search
    for (const [fileId, syms] of this.symbolsByFileId.entries()) {
      const match = syms.find((s) => s.name === cleanSymbol);
      if (match) {
        const file = this.fileMapById.get(fileId);
        if (file) {
          return { file: file.path, line: match.line_start };
        }
      }
    }

    return null;
  }

  /**
   * Find FileRecord and Symbol by identifier or class name.
   */
  private findFileBySymbolOrName(
    ident: string,
    contextFile?: string,
    visited = new Set<string>()
  ): { file: FileRecord; symbol?: SymbolRecord } | null {
    if (contextFile && visited.has(contextFile)) return null;
    if (contextFile) visited.add(contextFile);
    const cleanIdent = ident.replace(/controller$/i, "").toLowerCase();

    // 1. Try imports of contextFile
    if (contextFile) {
      const srcFile = this.fileMapByNormPath.get(this.normalizeFilePath(contextFile));
      if (srcFile) {
        const deps = this.fileDependencies(srcFile.id);
        for (const d of deps) {
          if (d.statement.toLowerCase().includes(cleanIdent) || d.target.toLowerCase().includes(cleanIdent)) {
            const resolved = this.resolveImportToFile(contextFile, d.target);
            if (resolved) {
              const syms = this.fileSymbols(resolved.id);
              const sym = syms.find(
                (s) => s.name.toLowerCase() === ident.toLowerCase() || s.name.toLowerCase().includes(cleanIdent)
              );
              if (sym) {
                return { file: resolved, symbol: sym };
              }
              if (visited.size < 5) {
                const reExported = this.findFileBySymbolOrName(ident, resolved.path, visited);
                if (reExported?.symbol) return reExported;
              }
            }
          }
        }
      }
    }

    // 2. Try match file path
    for (const [norm, file] of this.fileMapByNormPath.entries()) {
      if (norm.toLowerCase().includes(cleanIdent) && norm.toLowerCase().includes("controller")) {
        const syms = this.fileSymbols(file.id);
        return { file, symbol: syms.find((s) => s.kind === "class") };
      }
    }

    return null;
  }

  /**
   * Build a VerticalSliceRecord structure from an execution chain.
   */
  private buildSliceRecordFromChain(
    httpMethod: string,
    routeUri: string,
    chain: ExecutionChainNode[],
    architectureStyle: string = "clean"
  ): Omit<VerticalSliceRecord, "id" | "created_at"> {
    const controllerNode = chain.find((c) => c.stage === "controller" || c.stage === "orchestrator");

    const ctrlParts = controllerNode?.symbol.split("::") || [];
    const controllerClass = ctrlParts[0] || "Controller";
    const actionName = ctrlParts[1] || "handle";

    return {
      domain_id: null,
      feature_key: null,
      http_method: httpMethod,
      route_uri: routeUri,
      route_name: `${httpMethod.toLowerCase()}.${routeUri.replace(/[^a-zA-Z0-9]/g, "_").replace(/^_+|_+$/g, "")}`,
      controller_class: controllerClass,
      action_name: actionName,
      controller_file: controllerNode?.file || null,
      controller_line: controllerNode?.line || 0,
      architecture_style: architectureStyle,
      entry_kind: "inferred_http_route",
      execution_chain_json: JSON.stringify(chain),
    };
  }

  private inferRouteUri(filePath: string, methodName: string): string {
    const base = filePath
      .split("/")
      .pop()
      ?.replace(/controller\.[^.]+$/i, "")
      .replace(/\.[^.]+$/, "")
      .toLowerCase();

    const resource = base ? `/${base}s` : "/resource";
    if (/store|create/i.test(methodName)) return resource;
    if (/show|get|find/i.test(methodName)) return `${resource}/:id`;
    if (/update|edit|patch/i.test(methodName)) return `${resource}/:id`;
    if (/delete|destroy|remove/i.test(methodName)) return `${resource}/:id`;

    return `${resource}/${methodName}`;
  }

  private normalizeFilePath(p: string): string {
    return p.replace(/\\/g, "/").replace(/^\.\/?/, "").toLowerCase();
  }
}
