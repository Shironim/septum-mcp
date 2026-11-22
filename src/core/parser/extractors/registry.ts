import type {
  SemanticSliceExtractor,
  VerticalSliceCandidate,
} from "./semantic-extractor.interface.ts";
import { LaravelSemanticExtractor } from "./laravel-semantic.ts";
import { SymfonySemanticExtractor } from "./symfony-semantic.ts";
import { McpCliSemanticExtractor } from "./mcp-cli-semantic.ts";
import { NestJsSemanticExtractor } from "./nestjs-semantic.ts";
import { FastApiSemanticExtractor } from "./fastapi-semantic.ts";
import { DjangoSemanticExtractor } from "./django-semantic.ts";
import { FlaskSemanticExtractor } from "./flask-semantic.ts";
import { GoSemanticExtractor } from "./go-semantic.ts";
import { ExpressSemanticExtractor } from "./express-semantic.ts";
import { FastifySemanticExtractor } from "./fastify-semantic.ts";
import { HonoSemanticExtractor } from "./hono-semantic.ts";
import { ElysiaSemanticExtractor } from "./elysia-semantic.ts";
import { NextJsSemanticExtractor } from "./nextjs-semantic.ts";
import { scanSourceFiles, type SourceInventory } from "../../resources/source-inventory.ts";
import { shouldIgnoreSourcePath } from "../../resources/ignore.ts";

export interface AdapterExtractionResult { id: string; slices: number }
interface ExtractionOptions {
  ignorePatterns?: string[];
  inventory?: SourceInventory;
  onResult?: (result: AdapterExtractionResult) => void;
}

export class SemanticSliceExtractorRegistry {
  private static extractors: SemanticSliceExtractor[] = [
    new LaravelSemanticExtractor(),
    new SymfonySemanticExtractor(),
    new McpCliSemanticExtractor(),
    new NestJsSemanticExtractor(),
    new ExpressSemanticExtractor(),
    new FastifySemanticExtractor(),
    new HonoSemanticExtractor(),
    new ElysiaSemanticExtractor(),
    new NextJsSemanticExtractor(),
    new FastApiSemanticExtractor(),
    new DjangoSemanticExtractor(),
    new FlaskSemanticExtractor(),
    new GoSemanticExtractor(),
  ];

  public static getCapabilities(projectRoot?: string, framework?: string) {
    return this.extractors.map(extractor => {
      let applicable: boolean | null = null;
      let diagnostic: string | undefined;
      try { if (projectRoot) applicable = extractor.canHandle(projectRoot, framework); }
      catch (error) { diagnostic = error instanceof Error ? error.message : String(error); }
      return { id: extractor.id, name: extractor.name, coverage: "partial", registered: true, applicable,
        extraction: "not_established_by_registration", ...(diagnostic ? { diagnostic } : {}),
      };
    });
  }

  /**
   * Registers a new semantic slice extractor strategy.
   * Prepends to the list to give higher priority to custom extractors.
   */
  public static register(extractor: SemanticSliceExtractor): () => void {
    this.extractors.unshift(extractor);
    return () => { this.extractors = this.extractors.filter(item => item !== extractor); };
  }

  /**
   * Returns all extractors capable of handling the specified project topology.
   */
  public static getExtractors(projectRoot: string, framework?: string): SemanticSliceExtractor[] {
    return this.extractors.filter((extractor) => extractor.canHandle(projectRoot, framework));
  }

  /**
   * Executes all matched extractors and combines their vertical slices.
   */
  public static async extractAllSlices(
    projectRoot: string,
    framework?: string,
    domainId?: number,
    signal?: AbortSignal,
    options: ExtractionOptions = {}
  ): Promise<VerticalSliceCandidate[]> {
    const matched = this.getExtractors(projectRoot, framework);
    const sources = options.inventory ?? scanSourceFiles(projectRoot, { ignorePatterns: options.ignorePatterns, signal });
    const combinedSlices: VerticalSliceCandidate[] = [];

    for (const extractor of matched) {
      signal?.throwIfAborted();
      let slices: VerticalSliceCandidate[];
      try { slices = await extractor.extractSlices(projectRoot, domainId, signal, sources); }
      catch (error) { signal?.throwIfAborted(); throw new Error(`Semantic adapter '${extractor.id}' failed: ${error instanceof Error ? error.message : String(error)}`); }
      signal?.throwIfAborted();
      const selected = slices.filter(slice => !slice.controller_file || !shouldIgnoreSourcePath(slice.controller_file, options.ignorePatterns));
      options.onResult?.({ id: extractor.id, slices: selected.length });
      combinedSlices.push(...selected);
    }

    return combinedSlices;
  }

}
