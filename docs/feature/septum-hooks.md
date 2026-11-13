# Feature SSOT: Septum Hooks System (Real-Time Pre-Write & Post-Write Interception)

## 1. Background & Business Requirements

AI Coding Agents (such as Antigravity, Claude Code, Cursor, Codex) operate autonomously by executing file manipulation tools (`write_to_file`, `edit_file`, `replace_file_content`). Fundamental challenges in this autonomous workflow include:

1. **Agent Carelessness:** Agents frequently fail to call architectural validation tools (`septum_boundary`) prior to mutating code. As a result, forbidden imports and cyclic dependencies are committed directly to disk.
2. **Late Detection:** If architectural checks are deferred until CI/CD or git commit hooks fire, human developers must intervene to prompt the agent to rewrite already modified files.
3. **Stale AST Latency:** Whenever an agent modifies code on disk, the AST index in SQLite must be updated immediately without imposing blocking latency on agent execution.

**The Septum Hooks Solution:**
Septum provides a **Bidirectional Hooks System (Pre-Write & Post-Write)** integrated directly into agent harnesses and the host operating system:
* **Pre-Write Hook:** Functions as an active in-memory *Circuit Breaker* that intercepts proposed replacement code and aborts the disk mutation if an architectural violation is detected.
* **Post-Write Hook:** Functions as a non-blocking *Background Synchronizer* that immediately kicks off incremental AST indexing as soon as a file is written to disk.

---

## 2. Septum Hooks Workflow Diagram

```
           AI Coding Agent (Antigravity / Claude Code / Cursor / Codex)
                                      │
                                      ▼
                         Invokes File Mutation Tool:
             [write_to_file / replace_file_content / edit_file]
                                      │
                                      ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ 1. PRE-WRITE HOOK (`septum hook pre-write`)                                │
│                                                                            │
│    a. Intercepts tool call payload via STDIN.                              │
│    b. Extracts target file path and replacement code string (`content`).   │
│    c. Parses replacement code into a Tree-Sitter AST in memory.            │
│    d. Extracts all proposed import statements (`proposedImports`).         │
│    e. Executes `BoundaryEvaluator.checkProposedChanges()`.                 │
└─────────────────────────────────────┬──────────────────────────────────────┘
                                      │
                   ┌──────────────────┴──────────────────┐
                   ▼                                     ▼
     Architectural Violation?                 Evaluation Passed?
                   │                                     │
                   ▼ YES                                 ▼ NO (Clean)
┌──────────────────────────────────────┐  ┌──────────────────────────────────┐
│ DECISION: DENY (BLOCKED)             │  │ DECISION: ALLOW                  │
│                                      │  │                                  │
│ • Prints descriptive error to STDERR │  │ • Emits `{decision: "allow"}`    │
│ • Emits JSON `{decision: "deny"}`    │  │ • Exit Code: 0                   │
│ • Exit Code: 1 (Unix) / 2 (Claude)   │  │ • Tool writes changes to disk    │
│ • ZERO BYTES MUTATED ON DISK!        │  └──────────────────┬───────────────┘
│ • Forces agent to self-correct       │                     │
└──────────────────────────────────────┘                     ▼
                                          ┌──────────────────────────────────┐
                                          │ 2. POST-WRITE HOOK               │
                                          │    (`septum hook post-write`)    │
                                          │                                  │
                                          │ • Fires immediately after write  │
                                          │ • Spawns background `septum sync`│
                                          │   asynchronously                 │
                                          │ • Updates SQLite SSOT instantly  │
                                          │ • Zero blocking latency!         │
                                          └──────────────────────────────────┘
```

---

## 3. Technical Implementation Details

### A. Pre-Write Hook (`runPreWriteHook`)
Implemented in [hook.ts](../../src/cli/commands/hook.ts):

1. **STDIN Sniffing & Payload Normalization:**
   The hook receives raw JSON from the agent harness. Input normalization supports multiple casing styles:
   * Target File: `toolInput.TargetFile`, `toolInput.file_path`, `toolInput.filePath`, `toolInput.Path`, or `toolInput.path`.
   * Replacement Content: `toolInput.ReplacementContent`, `toolInput.new_string`, `toolInput.content`, `toolInput.Content`, `toolInput.Replacement`, or `ReplacementChunks`.
2. **In-Memory AST Parsing (Zero Disk Impact):**
   ```typescript
   const astEngine = new ASTParserEngine();
   const parsed = await astEngine.parseFile(targetFile, content);
   const proposedImports = parsed.dependencies.map((d) => d.target);
   ```
   Replacement text is parsed into an AST in memory before any disk write occurs.
3. **Module Boundary Check:**
   ```typescript
   const boundaryViolations = evaluator.checkProposedChanges(targetFile, proposedImports, config);
   ```
4. **Execution Blocking (`blockHook`):**
   If violations are detected, execution halts immediately via `blockHook()`:
   * **STDERR:** Emits human/agent-readable diagnostic messages:
     ```
     [SEPTUM BOUNDARY VIOLATION - Forbidden Cross-Domain Import]
     ✕ Operation blocked: Proposed code imports forbidden domain 'billing' from 'ordering'.
     ▶ OFFENDING IMPORT: ../billing/billing.service
     ▶ RULE: forbidden_dependency
     ▶ REQUIRED ACTION: Decouple this dependency. Use an authorized Interface, Event, or Shared Kernel.
     ```
   * **STDOUT:** Emits the IPC JSON contract:
     ```json
     { "decision": "deny", "reason": "Proposed code imports forbidden domain 'billing' from 'ordering'." }
     ```
   * **Exit Code:** Returns exit code `1` (Unix standard) or `2` (Claude Code / Cursor hook standard).

### B. Post-Write Hook (`SEPTUM_POST_WRITE_SCRIPT`)
After a tool call successfully writes compliant code to disk:
* The hook touches `.septum/sync.pending` and attempts an atomic, non-blocking lock acquisition via `mkdir .septum/sync.lock` (recovering automatically if a previous holder PID is no longer alive).
* If another background sync is already active, the hook exits `0` immediately to prevent a process stampede during rapid multi-file agent bursts.
* The active lock holder drains `.septum/sync.pending` in a detached background loop (`septum sync >/dev/null 2>&1 &`), ensuring the AST index in `.septum/septum.db` converges to the latest disk state with zero blocking latency.

---

## 4. Cross-Harness & Git Compatibility

Septum hook configurations are generated automatically via [hooks.ts](../../src/cli/templates/hooks.ts) across target environments:

| Platform | Integration & Protocol |
|---|---|
| **Google Antigravity IDE / Gemini** | Uses `PreToolUse` and `PostToolUse` configurations based on JSON IPC contracts (`{ decision: "allow" | "deny" }`). |
| **Claude Code & Cursor** | Uses `--exit-code-2` or `--claude` / `--cursor` flags so the agent harness captures tool failures and directs the LLM to resolve boundary violations autonomously. |
| **Git Pre-Commit Hook** | Installed in `.git/hooks/pre-commit` or `.husky/pre-commit`, running `septum check --staged` to block `git commit` if violations were introduced manually by developers. |

---

## 5. Summary of Business Value

1. **Zero Disk Contamination:** Architecturally invalid code is rejected before writing a single byte to disk.
2. **Zero-Latency Feedback:** AI agents receive immediate feedback explaining why an edit was blocked within milliseconds, along with actionable decoupling recommendations (*Decouple dependency via Interface/Event*).
3. **Always-Fresh SSOT:** Post-write hooks ensure the SQLite index remains continuously synchronized with file system state.
