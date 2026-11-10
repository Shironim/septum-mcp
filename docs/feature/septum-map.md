# Feature SSOT: `septum_map` (Macro Architecture & Domain Catalog)

## 1. Latar Belakang & Kebutuhan Bisnis (Business Requirements)

Saat pertama kali bekerja pada repository backend yang besar, AI Coding Agent menghadapi masalah **"Cold Start"**:
1. Agent tidak mengetahui pola arsitektur proyek (apakah *Clean Architecture*, *Modular DDD*, *Layered MVC*, atau *Monorepo*).
2. Agent tidak mengetahui batas modul (*bounded context*) dan domain mana yang boleh mengimpor domain lain.
3. Agent sering melakukan panggilan terminal acak (`ls`, `find`, `grep`) yang menghabiskan token dan lambat.

`septum_map` memecahkan masalah ini dengan menyediakan **peta makro arsitektural instan (*Telescope View*)** dan **katalog berkas terstruktur per domain** sebelum agent menyentuh kode sumber.

---

## 2. Dua Mode Utama `action: "catalog"`

### Mode A: Macro Bird's-Eye View (Saat `domain` dikosongkan)
Memberikan gambaran arsitektur tingkat tinggi dari seluruh sistem:
* **Telescope View:** Menyajikan tipe proyek (`project_type`), framework yang terdeteksi (`framework`), gaya arsitektur (`architecture_style`), dan jumlah total rute/slice eksekusi (`total_vertical_slices`).
* **Daftar Bounded Domains:** Menampilkan domain terdaftar, folder root-nya, archetype yang dikandung, serta aturan ketergantungan (`allowed_dependencies` dan `forbidden_dependencies`).
* **Scanned vs Ignored Folders:** Memberikan visibilitas folder mana saja yang diindeks dan folder mana yang sengaja diabaikan (misal `tests`, `public`, `assets`).

```json
// Request
{ "action": "catalog" }

// Response
{
  "telescope_view": {
    "project_type": "backend",
    "framework": "nestjs",
    "architecture_style": "modular-ddd",
    "total_domains": 3,
    "total_vertical_slices": 48,
    "scanned_folders": ["src/modules/ordering", "src/modules/billing", "src/modules/common"],
    "ignored_folders": ["node_modules", "dist", "tests", "coverage"]
  },
  "domains": [
    {
      "name": "ordering",
      "root": "src/modules/ordering",
      "archetypes": ["controller", "service", "repository", "dto", "entity"],
      "allowed_dependencies": ["common"],
      "forbidden_dependencies": ["billing"]
    },
    {
      "name": "billing",
      "root": "src/modules/billing",
      "archetypes": ["controller", "service", "repository", "dto"],
      "allowed_dependencies": ["common", "ordering"],
      "forbidden_dependencies": []
    }
  ]
}
```

### Mode B: Granular Domain Catalog (Saat `domain: "<name>"` diisi)
Ketika agent ingin fokus pada satu domain tertentu:
* **`detail_level: "compact"` (Default, Hemat Token):** Menampilkan daftar file dalam domain, archetype-nya (controller, service, model), jumlah baris, serta ringkasan symbol (`methods_count`, `properties_count`, line span).
* **`detail_level: "full"`:** Menampilkan deklarasi symbol lengkap, signature method, serta graf relasi import antar file.
* **Penyaringan Berdasarkan Archetype (`archetype_filter`):** Agent dapat menyaring file spesifik:
  ```json
  { "action": "catalog", "domain": "ordering", "archetype_filter": "controller" }
  ```

---

## 3. Sub-Operasi `action: "register"` (Registrasi Domain Dinamis)

Jika developer atau AI agent membuat modul/bounded context baru, domain dapat didaftarkan secara dinamis tanpa perlu mengedit file konfigurasi manual:

```json
// Request
{
  "action": "register",
  "name": "shipping",
  "root": "src/modules/shipping",
  "allowed_dependencies": ["common", "ordering"],
  "forbidden_dependencies": ["billing"],
  "ingest_now": true
}
```
* **Validasi Kepemilikan Root:** Septum memverifikasi bahwa folder `root` tidak tumpang tindih (*root collision*) dengan domain yang sudah ada.
* **Instant Persistence:** Konfigurasi langsung disimpan ke tabel `domains` di SQLite, dan jika `ingest_now: true`, file-file di dalamnya langsung diindeks.

---

## 4. Mekanisme Deteksi Topologi Otomatis (`TopologyDetector`)

Saat Septum dijalankan di sebuah workspace, engine **`TopologyDetector`** ([topology-detector.ts](../../src/core/discovery/topology-detector.ts)) mendeteksi bahasa, framework, dan pola arsitektur secara otomatis tanpa konfigurasi awal:

```
                            Project Root
                                 │
         ┌───────────────────────┴───────────────────────┐
         ▼                                               ▼
1. Deteksi Bahasa                               2. Deteksi Framework
   • PHP: composer.json, artisan                   • Laravel: artisan
   • Go: go.mod                                    • Symfony: bin/console, symfony.lock
   • Python: pyproject.toml, requirements.txt      • NestJS: @nestjs/core di package.json
   • TS/JS: tsconfig.json, package.json            • Express, Fastify, Hono, Elysia
                                                   • FastAPI, Django, Flask (Python)
                                                   • Gin, Echo, Chi, Fiber (Go)
                                 │
         ┌───────────────────────┴───────────────────────┐
         ▼                                               ▼
3. Klasifikasi Tipe Proyek                      4. Pemetaan Gaya Arsitektur
   • monorepo (pnpm, turbo, lerna, nx)             • monorepo-workspaces (apps/*, packages/*)
   • backend (API framework murni)                 • modular-ddd (domains/*, modules/*)
   • fullstack (Next.js, Nuxt, Laravel Blade)      • layered-monolith (app/Http/Controllers, dll.)
   • cli-mcp (MCP server SDK, CLI)                 • clean-architecture (Go cmd/*, internal/*)
```

### Aturan Partisi Domain Otomatis
* **Monorepo Workspaces:** Setiap subfolder di `apps/*` dan `packages/*` dipetakan menjadi domain independen. Aturan ketergantungan otomatis dibuat: `apps` boleh mengimpor `packages`, tetapi `packages` dilarang mengimpor `apps`.
* **Modular DDD:** Struktur folder seperti `src/domains/*`, `src/modules/*`, `app/Domain/*`, atau `features/*` otomatis diisolasi menjadi domain terpisah dengan dependensi hanya ke `shared` atau `common`.
* **Go Clean Architecture:** Folder `cmd/` dipetakan sebagai entrypoint, `internal/` sebagai domain privat, dan `pkg/` sebagai shared library publik. Aturan diset: `internal` tidak boleh diimpor dari luar, dan `pkg` dilarang mengimpor `cmd`.
* **Layered Monolith (Laravel MVC / NestJS Layered):** Folder dipetakan berdasarkan layer arsitektur (`app/Http/Controllers`, `app/Services`, `app/Models`, dll.).

---

## 5. Ringkasan Nilai SSOT di Database SQLite (`repo_meta`)

Seluruh kesimpulan topologi disimpan secara permanen di database internal:
* `repo_meta.framework`: Menyimpan nama framework (misal `"laravel"`, `"nestjs"`, `"fastapi"`, `"gin"`).
* `repo_meta.language`: Menyimpan bahasa utama (`"typescript"`, `"php"`, `"python"`, `"go"`).
* `repo_meta.architecture_style`: Menyimpan pola arsitektur (`"modular-ddd"`, `"clean-architecture"`, dll.).
* `repo_meta.project_type`: Menyimpan tipe proyek (`"backend"`, `"monorepo"`, `"fullstack"`).
