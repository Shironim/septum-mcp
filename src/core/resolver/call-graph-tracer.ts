import { ImportResolver } from "./import-resolver.ts";
import { readOptionalSourceFile } from "../resources/source-files.ts";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import type {
  ExecutionChainNode,
  FileRecord,
  SymbolRecord,
  VerticalSliceRecord,
} from "../../types/index.ts";
import type { SeptumRepository } from "../database/repository.ts";

export interface DiscoveredRoute {
  method: string;
  uri: string;
  file: string;
  line: number;
  middlewareSymbols: string[];
  handlerSymbol?: string;
  handlerClass?: string;
  handlerMethod?: string;
}

export class CallGraphTracer {
  private importEvidence?: ReturnType<SeptumRepository["getImportRelationships"]>;
  private evidenceByFile = new Map<string, ReturnType<SeptumRepository["getImportRelationships"]>>();
  private fileMapByNormPath: Map<string, FileRecord> = new Map();
  private fileMapById: Map<number, FileRecord> = new Map();
  private symbolsByFileId: Map<number, SymbolRecord[]> = new Map();
  private dependenciesByFileId: Map<
    number,
    Array<{ target: string; statement: string; line_number: number; is_external: boolean }>
  > = new Map();

  constructor(private repo: SeptumRepository, private projectRoot: string = process.cwd()) {}

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
    this.symbolsByFileId.clear(); this.dependenciesByFileId.clear(); this.evidenceByFile.clear();
    const allSymbolsWithFiles = this.repo.getAllSymbolsWithFiles();
    const allDeps = this.repo.getAllDependenciesWithDomains();
    this.importEvidence = this.repo.getMeta?.("workspace_root") ? this.repo.getImportRelationships(this.projectRoot) : undefined;

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

  /**
   * Discover declarative HTTP routes from known route/router files in the repository.
   */
  public discoverDeclarativeRoutes(): DiscoveredRoute[] {
    const discovered: DiscoveredRoute[] = [];

    for (const [normPath, file] of this.fileMapByNormPath.entries()) {
      const isRouteFile =
        file.archetype === "route" ||
        /routes?|router|endpoints?/i.test(normPath) ||
        /\.(routes?|router)\.[tj]sx?$/i.test(normPath);

      if (!isRouteFile) continue;

      const fullPath = resolve(this.projectRoot, file.path);
      if (!existsSync(fullPath)) continue;

      try {
        const content = readOptionalSourceFile(fullPath, "utf-8");
        const lines = content.split("\n");

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Pattern: router.post('/api/orders', validateMiddleware, controller.action)
          // or app.get('/orders', handler)
          const match = line.match(
            /(?:router|app|server|api)\.(get|post|put|patch|delete|options|head)\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*(.+)\)/i
          );

          if (match) {
            const method = match[1].toUpperCase();
            const uri = match[2];
            const rawArgs = match[3];

            const argTokens = rawArgs
              .split(",")
              .map((t) => t.trim())
              .filter((t) => t.length > 0 && !t.startsWith("//"));

            const middlewareSymbols: string[] = [];
            let handlerSymbol: string | undefined;
            let handlerClass: string | undefined;
            let handlerMethod: string | undefined;

            if (argTokens.length === 1) {
              handlerSymbol = argTokens[0];
            } else if (argTokens.length > 1) {
              handlerSymbol = argTokens[argTokens.length - 1];
              middlewareSymbols.push(...argTokens.slice(0, argTokens.length - 1));
            }

            if (handlerSymbol) {
              // Extract Class.method or classInstance.method
              const parts = handlerSymbol.split(".");
              if (parts.length === 2) {
                handlerClass = parts[0];
                handlerMethod = parts[1];
              } else if (handlerSymbol.includes("::")) {
                const colParts = handlerSymbol.split("::");
                handlerClass = colParts[0];
                handlerMethod = colParts[1];
              }
            }

            discovered.push({
              method,
              uri,
              file: file.path,
              line: i + 1,
              middlewareSymbols,
              handlerSymbol,
              handlerClass,
              handlerMethod,
            });
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Septum CallGraph Warning] Route discovery failed for ${file.path}: ${msg}`);
      }
    }

    return discovered;
  }

  /**
   * Build execution chains for all discovered entrypoints and controller actions.
   */
  public traceAllSlices(maxDepth: number = 5, options: { includeInferredControllers?: boolean; excludeEntrypointFiles?: ReadonlySet<string> } = {}): Array<Omit<VerticalSliceRecord, "id" | "created_at">> {
    const effectiveMaxDepth = Math.min(Math.max(Math.trunc(maxDepth || 5), 1), 8);
    this.initMaps();
    const slices: Array<Omit<VerticalSliceRecord, "id" | "created_at">> = [];
    const declarativeRoutes = this.discoverDeclarativeRoutes();

    // 1. Trace from declarative routes
    for (const route of declarativeRoutes) {
      if (options.excludeEntrypointFiles?.has(route.file)) continue;
      const chain = this.traceChainFromRoute(route, effectiveMaxDepth);
      if (chain.length > 0) {
        const sliceRecord = this.buildSliceRecordFromChain(
          route.method,
          route.uri,
          chain,
          "clean"
        );
        slices.push(sliceRecord);
      }
    }

    if (options.includeInferredControllers === false) return slices;

    // 2. Trace controllers if routes were not explicitly bound or found
    for (const [normPath, file] of this.fileMapByNormPath.entries()) {
      const isController =
        file.archetype === "controller" ||
        /controller/i.test(normPath) ||
        normPath.endsWith("Controller.ts") ||
        normPath.endsWith("Controller.js");

      if (!isController) continue;

      const symbols = this.fileSymbols(file.id);
      const methods = symbols.filter((s) => s.kind === "method" || s.kind === "function");

      for (const m of methods) {
        // Skip constructors or private helpers
        if (m.name === "constructor" || m.name.startsWith("_")) continue;

        // Check if this method was already covered by declarative routes
        const alreadyCovered = slices.some(
          (s) =>
            s.controller_file === file.path &&
            s.action_name.toLowerCase() === m.name.toLowerCase()
        );
        if (alreadyCovered) continue;

        const chain = this.traceChainFromController(file, m, effectiveMaxDepth);
        if (chain.length > 0) {
          const defaultMethod = /create|store|save|add/i.test(m.name)
            ? "POST"
            : /update|edit|patch/i.test(m.name)
            ? "PUT"
            : /delete|remove|destroy/i.test(m.name)
            ? "DELETE"
            : "GET";

          const inferredUri = this.inferRouteUri(file.path, m.name);
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
    const ctrlName =
      syms.find((s) => s.kind === "class")?.name ||
      controllerFile.path.split("/").pop()?.replace(/\.[^.]+$/, "") ||
      "Controller";

    // Stage 1: Ingress (inferred)
    const inferredUri = this.inferRouteUri(controllerFile.path, method.name);
    const defaultMethod = /create|store|save|add/i.test(method.name)
      ? "POST"
      : /update|edit|patch/i.test(method.name)
      ? "PUT"
      : /delete|remove|destroy/i.test(method.name)
      ? "DELETE"
      : "GET";

    chain.push({
      stage: "ingress",
      symbol: `${defaultMethod} ${inferredUri}`,
      file: controllerFile.path,
      line: method.line_start,
      description: `Inferred Ingress: ${defaultMethod} ${inferredUri}`,
    });

    // Stage 3: Controller
    chain.push({
      stage: "controller",
      symbol: `${ctrlName}::${method.name}`,
      file: controllerFile.path,
      line: method.line_start,
      description: `Controller Action: ${ctrlName}::${method.name}`,
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
    const methodSymbol = symbols.find(
      (s) => (s.kind === "method" || s.kind === "function") && (s.name.endsWith(`::${actionName}`) || s.name.endsWith(`@${actionName}`) || s.name === actionName)
    );

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
      methodBody = this.scopeWithInjectedTypes(fileContent, lines.slice(start, end).join("\n"));
    } catch {
      return this.expandChainFromFile(controllerFilePath, existingChain, maxDepth);
    }

    const chain = [...existingChain];
    this.traverseMethodScopedDependencies(startFile, methodBody, methodSymbol, chain, effectiveMaxDepth);
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
    const visitedFiles = new Set<string>();
    visitedFiles.add(startFile.path);

    const deps = this.fileDependencies(startFile.id);
    const scopeText = (methodSymbol.signature || "") + "\n" + methodBody;

    for (const dep of deps) {
      if (/^\s*(?:import|export)\s+type\b/.test(dep.statement)) continue;
      if (chain.length >= CallGraphTracer.MAX_CHAIN_NODES) break;
      const importedNames = this.extractImportedSymbolNames(dep.statement);
      const baseTarget = dep.target.split(/[\/\\]/).pop()?.replace(/\.[^.]+$/, "") || "";

      // Only include if imported symbol or target name is referenced in the method scope (signature + body)
      const isReferenced =
        (importedNames.length > 0 &&
          importedNames.some((name) => {
            const camel = name.charAt(0).toLowerCase() + name.slice(1);
            return scopeText.includes(name) || scopeText.includes(camel);
          })) ||
        (baseTarget.length > 0 &&
          (scopeText.includes(baseTarget) ||
            scopeText.includes(baseTarget.charAt(0).toLowerCase() + baseTarget.slice(1))));

      if (!isReferenced) {
        // Drop uncalled static import to eliminate cognitive noise and payload bloat
        continue;
      }

      const resolvedFiles = this.repo.getMeta?.("workspace_root")
        ? this.resolveImportTargets(startFile.path, dep.target)
        : dep.is_external
        ? []
        : [this.resolveImportToFile(startFile.path, dep.target)].filter((file): file is FileRecord => !!file);

      for (const resolvedFile of resolvedFiles) {
        if (!resolvedFile || visitedFiles.has(resolvedFile.path)) continue;
        visitedFiles.add(resolvedFile.path);

        const stage = this.detectStage(resolvedFile.path, resolvedFile.archetype);
        const fileSymbols = this.fileSymbols(resolvedFile.id);
        const mainSymbol = this.resolveExecutableSymbol(fileSymbols, importedNames);
        if (!mainSymbol) {
          continue;
        }

        const symbolDisplay = mainSymbol.name;

        const shortSymbolDisplay = symbolDisplay.split(/[\\:]/).pop();
        const existingNode = chain.find(
          (c) =>
            (c.file && c.file === resolvedFile.path) ||
            (c.stage === stage &&
              (c.symbol === symbolDisplay || c.symbol.split(/[\\:]/).pop() === shortSymbolDisplay))
        );

        if (!existingNode) {
          chain.push({
            stage,
            symbol: symbolDisplay,
            file: resolvedFile.path,
            line: mainSymbol.line_start || 1,
            description: `${stage.toUpperCase()} (referenced import): ${symbolDisplay}`,
            relationship: {
              kind: "imports",
              derivation: "source",
              source: { file: startFile.path, line: dep.line_number, statement: dep.statement },
              reason: "import referenced in method scope; not proof of a call",
            },
          });
        }
      }
    }
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
    if (!statement) return [];
    const names = new Set<string>();
    const braceMatch = statement.match(/\{([^}]+)\}/);
    if (braceMatch) {
      for (const spec of braceMatch[1].split(",")) {
        const cleaned = spec.trim().replace(/^type\s+/, "");
        const parts = cleaned.split(/\s+as\s+/);
        for (const p of parts) {
          const id = p.trim();
          if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(id)) names.add(id);
        }
      }
    }
    const defaultMatch = statement.match(/^\s*import\s+(?:type\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s+from\b/);
    if (defaultMatch) names.add(defaultMatch[1]);
    const pyMatch = statement.match(/\bfrom\s+[^\s]+\s+import\s+([^;(\n]+)/);
    if (pyMatch) {
      for (const spec of pyMatch[1].split(",")) {
        const parts = spec.trim().split(/\s+as\s+/);
        const id = (parts[0] || "").trim();
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) names.add(id);
      }
    }
    const phpMatch = statement.match(/^\s*use\s+(?:function\s+|const\s+)?[A-Za-z0-9_\\]+\\([A-Za-z0-9_]+)/);
    if (phpMatch) names.add(phpMatch[1]);
    return Array.from(names);
  }

  /**
   * Detect generic pipeline stage from file path and archetype.
   */
  public detectStage(filePath: string, archetype: string): string {
    const norm = filePath.toLowerCase();

    if (
      archetype === "validation" ||
      archetype === "dto" ||
      /validation|middleware|dto|request|schema/i.test(norm)
    ) {
      return "validation";
    }

    if (archetype === "controller" || /controller|handler/i.test(norm)) {
      return "controller";
    }

    if (
      archetype === "service" ||
      archetype === "use_case" ||
      /use-?cases?|interactor|application|workflow/i.test(norm)
    ) {
      return "use_case";
    }

    if (
      archetype === "model" ||
      archetype === "entity" ||
      /domain|entities|entity|aggregate/i.test(norm)
    ) {
      return "entity";
    }

    if (
      archetype === "repository" ||
      /repositories|repository|database|persistence|egress|adapter/i.test(norm)
    ) {
      return "repository";
    }

    return "service";
  }

  /**
   * Resolve an import target path (relative or alias) to a FileRecord in the catalog.
   */
  public resolveImportTargets(sourceFilePath: string, importTarget: string): FileRecord[] {
    if (!this.importEvidence && !this.evidenceByFile.has(sourceFilePath)) {
      this.evidenceByFile.set(sourceFilePath, this.repo.getImportRelationships(this.projectRoot, sourceFilePath));
    }
    const evidence = (this.importEvidence ?? this.evidenceByFile.get(sourceFilePath))?.find(edge => edge.source.file === sourceFilePath && edge.resolution.source.target === importTarget);
    if (evidence && (evidence.freshness !== "current" || evidence.index_coverage !== "complete")) return [];
    const result = evidence?.resolution ?? new ImportResolver(this.projectRoot, this.repo.getAllDomains?.().map(domain => domain.root_path) ?? []).resolve(importTarget,sourceFilePath);
    if (result.status !== "resolved" || result.coverage === "conditional") {
      // Fallback: check symbols in repository (e.g. PHP namespace classes, Go packages, Python modules)
      const matching = this.repo.findSymbolsByName(importTarget);
      if (matching.length === 1) {
        const file = this.fileForPath(matching[0].file_path);
        if (file) return [file];
      }
      const shortName = importTarget.split(/[\/\\]/).pop();
      if (shortName && shortName !== importTarget) {
        const shortMatches = this.repo.findSymbolsByName(shortName);
        if (shortMatches.length === 1) {
          const file = this.fileForPath(shortMatches[0].file_path);
          if (file) return [file];
        }
      }
      return [];
    }
    return result.targets.flatMap(target => target.files).flatMap(file => {
      const indexed = this.fileForPath(file);
      return indexed ? [indexed] : [];
    });
  }

  public resolveImportToFile(sourceFilePath: string, importTarget: string): FileRecord | undefined {
    if (this.repo.getMeta?.("workspace_root")) {
      const targets = this.resolveImportTargets(sourceFilePath,importTarget);
      return targets.length === 1 ? targets[0] : undefined;
    }
    // 1. Relative import (./ or ../)
    if (importTarget.startsWith(".")) {
      const sourceDir = dirname(sourceFilePath);
      const combined = normalize(join(sourceDir, importTarget)).replace(/\\/g, "/");

      const candidates = [
        combined,
        `${combined}.ts`,
        `${combined}.tsx`,
        `${combined}.js`,
        `${combined}.jsx`,
        `${combined}/index.ts`,
        `${combined}/index.js`,
      ];

      for (const cand of candidates) {
        const found = this.fileForPath(cand);
        if (found) return found;
      }
    }

    // 2. Alias import (@/... or src/...)
    const cleanAlias = importTarget.replace(/^@\//, "src/");
    const aliasCandidates = [
      cleanAlias,
      `${cleanAlias}.ts`,
      `${cleanAlias}.tsx`,
      `${cleanAlias}.js`,
      `${cleanAlias}.jsx`,
      `${cleanAlias}/index.ts`,
      `${cleanAlias}/index.js`,
    ];

    for (const cand of aliasCandidates) {
      const found = this.fileForPath(cand);
      if (found) return found;
    }

    // 3. Basename search fallback
    const baseTarget = importTarget.split("/").pop()?.replace(/\.[^.]+$/, "");
    if (baseTarget && baseTarget.length > 3) {
      for (const [norm, file] of this.fileMapByNormPath.entries()) {
        if (norm.includes(`/${baseTarget.toLowerCase()}.`) || norm.endsWith(`/${baseTarget.toLowerCase()}`)) {
          return file;
        }
      }
    }

    return undefined;
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
      entry_kind: "http_route",
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
