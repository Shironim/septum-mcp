# Static import resolution

`ImportResolver` maps an extracted import to local files/packages, a declared external dependency, or an explicit uncertainty. Resolver revision `5` adds bounded Python manifest ownership, Go workspaces/replacements, Ruby requires, Rust modules/Cargo paths, and local Java/C# source resolution.

## Shared contract

Results contain `status`, `reason`, `targets`, `coverage`, resolver/configuration revisions and the source file/target. Status is one of `resolved`, `external`, `unresolved`, `ambiguous` or `unsupported`. Targets are file records or package records containing multiple files. Coverage remains `partial`, or `conditional` when configuration can change the selected file set.

`external` describes supported platform imports or manifest-declared distributions. It does not establish that a package is installed or loadable. `resolved` describes selected static source; it does not prove runtime dispatch. Boundary consumers treat conditional resolution as incomplete.

The resolver accepts the extracted statement in addition to the target/source. Repository relationships, staged audits and hook checks preserve this statement, which distinguishes Ruby `require` from `require_relative` and managed-language aliases/static imports. Raw proposal callers can supply a supported full Ruby/Java/C# statement when its syntax is needed for interpretation.

Reads are workspace-contained, including symlink destinations. Missing inputs and enumerated directories participate in observed-input tracking. Each resolution admits at most 16 MiB of read content, with the shared 2 MiB per-file limit. Recursive source scans stop after 20,000 entries or 64 levels; Rust module expansion and managed project-reference discovery have additional bounds. Resource failures remain unsupported evidence, not an empty successful resolution.

## Implemented language behavior

| Language | Supported static scope | Important limits |
| --- | --- | --- |
| Python | Nearest ancestor manifest owner; relative/local imports and supported path dependencies; requirements includes; PEP 621/Poetry dependency sections; Pipfile; Poetry/uv/Pipfile locks; selected distribution-to-module aliases | A lockfile distribution does not generally identify all import names; namespace packages, runtime sys.path and arbitrary aliases remain incomplete |
| Go | Nearest module; go.work use members; local replace directives and workspace replacement precedence; version-specific replacements; required external modules; multi-file packages | No downloads or external-workspace source reads; source module must be a workspace member; platform/build-tag file sets remain conditional |
| Ruby | Literal require_relative; conventional owner/lib load path; literal Gemfile declarations, selected gem aliases and lockfile gem names; literal path gems | Dynamic load paths, arbitrary Gemfile evaluation and Zeitwerk constant autoloading are not executed or completely modeled |
| Rust | Out-of-line module edges; inline module structure; crate/self/super; Cargo dependency aliases/workspace inheritance/path libraries; module globs and literal path attributes | cfg/optional dependencies remain conditional; macros, reexports, arbitrary build scripts and ambiguous same-file module contexts are not fully resolved |
| Java | Local source package/type lookup; nested types; selected static members/wildcards; literal Maven reactor dependencies/source roots; conventional Gradle project references | No build evaluation or complete binary classpath; external package ownership is not inferred from Maven group/artifact names; profiles/recognized conditional configuration remain conditional, custom Gradle layouts/source sets remain unsupported |
| C# | Local namespace/type file sets; using aliases; literal csproj project references; default and explicit Compile includes/removes, including linked files | MSBuild conditions/imports and source preprocessor conditions remain conditional; package names are not treated as proof of assembly namespaces |

TypeScript and JavaScript resolution handles relative imports, selected TypeScript aliases and workspace package entries. PHP resolution uses supported PSR-4 mappings and Composer metadata. Parser declaration coverage is documented separately in [the feature index](README.md).

## Manifest ownership and freshness

For TypeScript and JavaScript, the nearest `tsconfig.json` supplies compiler options. Explicit `extends` can bring in parent options. A nearer empty config leaves root aliases out of scope unless it inherits them. If package lookup also finds no declaration, the import stays `unresolved` with reason `package_not_declared`.

Python selects the nearest directory containing a supported manifest or lockfile. That owner supplies external dependency declarations; a nested application does not inherit unrelated root dependencies. Explicit registered roots can still contribute local source candidates. Mapping distributions such as PyJWT to `jwt` is separate from reading a lockfile's transitive package list.

Supported local directory/editable entries in Python manifests/locks are resolved to source or remain unresolved; their distribution names are not enough to classify them external. Ruby Gemfile path blocks, gemspec evaluation and dynamic configuration remain unsupported rather than being treated as ordinary external gem declarations. Duplicate C# type declarations remain ambiguous unless they are partial declarations.

Go workspace members and local replacements must remain inside the selected Septum workspace. Unrelated replacements no longer disable standard-library resolution. Replacement/source errors, ambiguous module roots and nested module boundaries remain explicit.

Watchers reconcile on supported interpretation-input changes. The same input predicate materializes manifests/project files in frozen Git-index snapshots and broadens staged analysis when their bytes change. This includes requirements/lockfiles, Gemfile, Cargo/go files, Maven/Gradle and C# project inputs. Unsupported dynamic includes or build outputs are not generated on the user's behalf.

Java/C# source scans are bounded but can inspect multiple files per import. Large-project latency and repeated scans across many imports have not been benchmarked by the regression suite. These paths have no cross-request retained resolution cache.

## Verification owners

- [Main dispatcher and content identity](../../src/core/resolver/import-resolver.ts)
- [Language resolvers](../../src/core/resolver/languages/)
- [Interpretation inputs](../../src/core/resolver/interpretation-inputs.ts)
- [Multilanguage resolution and consumer tests](../../tests/unit/multilanguage-import-resolver.test.ts)
- [Existing import regression suite](../../tests/unit/import-resolution.test.ts), [input lifecycle](../../tests/unit/resolution-input-lifecycle.test.ts)

The multilanguage suite exercises source resolution through ingestion, map, call-graph targets, workspace/staged boundary decisions, manifest-only changes and watcher reconciliation. It also verifies that the new implementation files parse with Septum's shipped TypeScript grammar. These local fixtures do not certify arbitrary real-world build systems or installed-server parity.
