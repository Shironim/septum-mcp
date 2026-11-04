import { z } from "zod";

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
      enforcement: z.enum(["strict", "warn"]).default("strict"),
      db_path: z.string().default(".septum/septum.db"),
      ignore_patterns: z
        .array(z.string())
        .default([
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
        ]),
    })
    .default({
      enforcement: "strict",
      db_path: ".septum/septum.db",
      ignore_patterns: [
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
      ],
    }),
  domains: z.record(DomainConfigSchema).default({}),
});

export type ValidatedSeptumConfig = z.infer<typeof SeptumConfigSchema>;
