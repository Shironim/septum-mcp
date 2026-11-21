import { z } from "zod";

export const DEFAULT_IGNORE_PATTERNS = [
  "node_modules/**",
  "vendor/**",
  "dist/**",
  "build/**",
  "out/**",
  "target/**",
  "coverage/**",
  ".venv/**",
  "venv/**",
  "__pycache__/**",
  "tests/**",
  "scripts/**",
  "bin/**",
  ".git/**",
  ".septum/**",
];

export const DomainConfigSchema = z.object({
  root: z.string().min(1, "root path cannot be empty"),
  description: z.string().optional(),
  allowed_dependencies: z.array(z.string()).default([]),
  forbidden_dependencies: z.array(z.string()).default([]),
  archetypes: z.record(z.string()).optional().default({}),
});

export const SeptumConfigSchema = z.object({
  version: z.string().default("1.0"),
  settings: z
    .object({
      enforcement: z.enum(["strict", "warn"]).default("warn"),
      db_path: z.string().default(".septum/septum.db"),
      ignore_patterns: z
        .array(z.string())
        .default(() => [...DEFAULT_IGNORE_PATTERNS]),
    })
    .default(() => ({
      enforcement: "warn" as const,
      db_path: ".septum/septum.db",
      ignore_patterns: [...DEFAULT_IGNORE_PATTERNS],
    })),
  domains: z.record(DomainConfigSchema).default({}),
});

export type ValidatedSeptumConfig = z.infer<typeof SeptumConfigSchema>;
