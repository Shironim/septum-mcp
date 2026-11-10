# Septum SSOT — Feature & Architecture Catalog

Septum adalah engine kecerdasan struktural backend berbasis **Tree-Sitter AST (Abstract Syntax Tree)** dan database relasional tersemat **SQLite (`.septum/septum.db`)**. Septum dirancang secara khusus untuk AI Coding Agents agar dapat bernavigasi, memahami arsitektur, melacak alur eksekusi, serta memodifikasi kode backend multi-bahasa tanpa terjebak dalam pembacaan file mentah (*brute-force grep* & *token-heavy full-file reads*).

---

## 1. Filosofi & Masalah yang Diselesaikan

Dalam pengembangan backend berskala menengah hingga besar:
1. **Perbedaan Bahasa & Sintaks:** Backend modern menggunakan berbagai bahasa (TypeScript, PHP, Python, Go, Rust, Java, C#) dengan framework berbeda (NestJS, Laravel, FastAPI, Gin, Symfony, Express). AI agent konvensional sering salah memahami struktur karena mengandalkan pencarian regex teks mentah.
2. **Token Bloat & Biaya Konteks:** Membaca ribuan baris file controller atau service hanya untuk mengetahui nama method atau kontrak DTO membuang 80–90% kuota context window AI agent.
3. **Ketidaktahuan Blast Radius:** AI agent sering mengubah signature fungsi tanpa mengetahui service mana saja yang memanggilnya, menyebabkan regresi atau bug runtime.
4. **Pelanggaran Arsitektur (*Architectural Drift*):** AI agent sering membuat import silang terlarang (misal domain billing langsung mengimpor domain order) atau menciptakan *circular dependency*.

Septum menyelesaikan masalah di atas dengan membangun **Single Source of Truth (SSOT)** graf dependensi, tabel symbol, topologi domain, dan rantai eksekusi vertikal (*vertical slice*) secara real-time.

---

## 2. Peta Dokumen Fitur (Feature SSOT Directory)

Setiap dokumen di dalam direktori `docs/feature/` ini merupakan **Single Source of Truth (SSOT)** definitif untuk setiap kapabilitas Septum:

| Dokumen SSOT | Fitur / Komponen | Fokus & Cakupan Utama |
|---|---|---|
| [septum-slice.md](./septum-slice.md) | `septum_slice` | **Vertical Execution Chain Tracer:** Melacak alur eksekusi vertikal dari Route Ingress, Middleware, Validation DTO, Controller, Service, hingga Database/Entity di 12 framework backend + fallback generic call-graph. Mendukung pemicu HTTP, CLI Command, Queue Job, dan Domain Event. |
| [septum-symbol.md](./septum-symbol.md) | `septum_symbol` | **AST Symbol Intelligence:** Sub-operasi `locate` (pencarian fuzzy Damerau-Levenshtein, parser error log/stack-trace), `context` (bounded AST slice 16 KB, anti-hollow slicing via 1-hop delegator expansion, ekstraksi DTO), dan `impact` (blast radius & analisis pemanggil ke belakang). |
| [septum-map.md](./septum-map.md) | `septum_map` | **Macro Architecture & Domain Catalog:** Peta makro proyek (*Telescope View*), katalog domain granular, registrasi domain dinamis (`register`), dan mekanisme deteksi topologi otomatis (*TopologyDetector*) untuk bahasa dan framework backend. |
| [septum-boundary.md](./septum-boundary.md) | `septum_boundary` | **Architectural Boundary Guard:** Penegakan aturan batas bounded-context (`forbidden_dependency`, `disallowed_dependency`, `circular_dependency`, `unmapped_domain`), smart type-only import erasure, simulasi pre-flight proposal, dan audit git-staged. |
| [septum-hooks.md](./septum-hooks.md) | Sistem Hooks Septum | **Real-Time Guard & Auto-Sync:** Pre-Write Hook (`PreToolUse`) untuk intersepsi dan pemblokiran mutasi file terlarang secara in-memory sebelum menyentuh disk, serta Post-Write Hook (`PostToolUse`) untuk sinkronisasi latar belakang non-blocking. |
| [workspace-lifecycle.md](./workspace-lifecycle.md) | Lifecycle & Invalidation | **Database SSOT & Hashing Engine:** Skema SQLite internal, penanganan perubahan file tipe (`types.ts`) & barrel files (`index.ts`) melalui *Transitive Invalidation*, serta proteksi revisi konfigurasi global (*Config Fingerprint*). |
| [symbol-context-contract.md](./symbol-context-contract.md) | Context Contract Host | **In-Memory TypeScript Compiler Host:** Spesifikasi teknis pemuatan AST dan proyeksi kontrak antarmuka DTO publik tanpa overhead memori `node_modules`. |

---

## 3. Matriks Routing Tool MCP untuk AI Agent

| Skenario Kebutuhan AI Agent | Panggil Tool MCP Ini | Keuntungan vs Pendekatan Konvensional |
|---|---|---|
| Memahami struktur proyek, batas domain, dan inventory file | `septum_map({ action: "catalog" })` | Mendapatkan peta makro instan tanpa menjalankan `ls` atau `find` berulang kali. |
| Melacak alur endpoint API, request DTO, dan tabel database yang dimutasi | `septum_slice({ query: "POST /path" })` | Langsung mendapatkan rantai eksekusi Route $\to$ DTO $\to$ Controller $\to$ Service $\to$ DB dalam 1 tool call. |
| Mengetahui koordinat file dan baris suatu fungsi/class (bahkan dari error log) | `septum_symbol({ action: "locate", query: "..." })` | Menemukan koordinat presisi via fuzzy Damerau-Levenshtein tanpa membaca file. |
| Memeriksa implementasi logika, parameter, atau return type | `septum_symbol({ action: "context", query: "..." })` | Menghasilkan potongan kode terikat (bounded slice) dan DTO tanpa membanjiri token window. |
| Mengetahui service mana saja yang memanggil fungsi A sebelum refactoring | `septum_symbol({ action: "impact", query: "..." })` | Menampilkan seluruh pemanggil ke belakang (*inbound callers*) dan estimasi level risiko regresi. |
| Memvalidasi apakah import baru melanggar aturan modul | `septum_boundary({ file_path: "...", proposed_imports: [...] })` | Mensimulasikan arsitektur secara pre-flight sebelum menulis ke disk. |
| Audit kepatuhan arsitektur sebelum commit | `septum_boundary({ scope: "staged" })` | Memastikan file yang di-stage bebas dari circular dependencies dan forbidden imports. |
