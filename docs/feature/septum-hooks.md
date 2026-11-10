# Feature SSOT: Sistem Hooks Septum (Real-Time Pre-Write & Post-Write Interception)

## 1. Latar Belakang & Kebutuhan Bisnis (Business Requirements)

AI Coding Agent (seperti Antigravity, Claude Code, Cursor, Codex) beroperasi secara otonom dengan mengeksekusi tool manipulasi berkas (`write_to_file`, `edit_file`, `replace_file_content`). Masalah mendasar dalam alur otonom ini adalah:

1. **Kelalaian Agent (*Agent Carelessness*):** Agent sering kali tidak memanggil tool pengecekan arsitektur (`septum_boundary`) sebelum menulis kode. Akibatnya, import terlarang atau siklus dependensi langsung masuk ke disk.
2. **Keterlambatan Deteksi (*Late Detection*):** Jika verifikasi arsitektur baru dilakukan saat CI/CD atau saat git commit, developer manusia harus turun tangan meminta agent merevisi kode yang sudah telanjur ditulis.
3. **Latensi Sinkronisasi (*Stale AST Latency*):** Setiap kali agent memodifikasi kode di disk, indeks database AST harus segera dimutakhirkan tanpa membuat agent menunggu lama (*blocking latency*).

**Solusi Sistem Hooks Septum:**
Septum menyediakan **Sistem Hooks 2 Arah (Pre-Write & Post-Write)** yang terintegrasi langsung dengan harness agent dan sistem operasi:
* **Pre-Write Hook:** Bertindak sebagai *Circuit Breaker* aktif yang mencegat isi kode pengganti secara in-memory dan membatalkan mutasi disk jika terbukti melanggar arsitektur.
* **Post-Write Hook:** Bertindak sebagai *Background Synchronizer* non-blocking yang langsung memicu sinkronisasi inkremental begitu berkas berhasil ditulis.

---

## 2. Diagram Alur Kerja Hooks Septum

```
           AI Coding Agent (Antigravity / Claude Code / Cursor / Codex)
                                      │
                                      ▼
                        Memanggil Tool Mutasi Berkas:
            [write_to_file / replace_file_content / edit_file]
                                      │
                                      ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ 1. PRE-WRITE HOOK (`septum hook pre-write`)                                │
│                                                                            │
│    a. Mencegat payload tool call melalui STDIN.                            │
│    b. Mengambil nama file target dan string kode baru (`content`).         │
│    c. Mem-parse string kode baru ke AST Tree-Sitter secara in-memory.      │
│    d. Mengekstrak seluruh daftar import yang diajukan (`proposedImports`). │
│    e. Menjalankan `BoundaryEvaluator.checkProposedChanges()`.              │
└─────────────────────────────────────┬──────────────────────────────────────┘
                                      │
                   ┌──────────────────┴──────────────────┐
                   ▼                                     ▼
      Ada Pelanggaran Arsitektur?               Lolos Evaluasi?
                   │                                     │
                   ▼ YA                                  ▼ TIDAK (Bersih)
┌──────────────────────────────────────┐  ┌──────────────────────────────────┐
│ KEPUTUSAN: DENY (BLOCKED)            │  │ KEPUTUSAN: ALLOW                 │
│                                      │  │                                  │
│ • Cetak pesan error ke STDERR        │  │ • Emisi `{decision: "allow"}`    │
│ • Emisi JSON `{decision: "deny"}`    │  │ • Exit Code: 0                   │
│ • Exit Code: 1 (Unix) / 2 (Claude)   │  │ • Tool menulis kode ke disk      │
│ • DISK TIDAK TERSENTUH SATU BYTE PUN!│  └──────────────────┬───────────────┘
│ • Agent dipaksa merevisi solusinya   │                     │
└──────────────────────────────────────┘                     ▼
                                          ┌──────────────────────────────────┐
                                          │ 2. POST-WRITE HOOK               │
                                          │    (`septum hook post-write`)    │
                                          │                                  │
                                          │ • Terpicu setelah file tersimpan │
                                          │ • Menjalankan `septum sync &`    │
                                          │   di background (asynchronous)   │
                                          │ • Indeks SQLite langsung update  │
                                          │ • Zero blocking latency!         │
                                          └──────────────────────────────────┘
```

---

## 3. Detail Mekanisme Teknis

### A. Pre-Write Hook (`runPreWriteHook`)
Diimplementasikan dalam [hook.ts](../../src/cli/commands/hook.ts):

1. **STDIN Sniffing & Normalisasi Payload:**
   Hook menerima data JSON dari agent harness. Format input yang dinormalisasi mencakup:
   * Target File: `toolInput.TargetFile`, `toolInput.file_path`, `toolInput.filePath`, atau `toolInput.path`.
   * Konten Baru: `toolInput.ReplacementContent`, `toolInput.new_string`, `toolInput.content`, atau potongan `ReplacementChunks`.
2. **In-Memory AST Parsing (Zero-Disk Impact):**
   ```typescript
   const astEngine = new ASTParserEngine();
   const parsed = await astEngine.parseFile(targetFile, content);
   const proposedImports = parsed.dependencies.map((d) => d.target);
   ```
   Teks kode baru diurai menjadi AST sebelum menyentuh file system.
3. **Pemeriksaan Batas Modul (*Boundary Check*):**
   ```typescript
   const boundaryViolations = evaluator.checkProposedChanges(targetFile, proposedImports, config);
   ```
4. **Eksekusi Pemblokiran (*Block Hook*):**
   Jika ditemukan pelanggaran, proses dihentikan seketika melalui `blockHook()`:
   * **STDERR:** Menampilkan pesan deskriptif yang mudah dibaca oleh agent/developer manusia:
     ```
     [SEPTUM BOUNDARY VIOLATION - Forbidden Cross-Domain Import]
     ✕ Operation blocked: Proposed code imports forbidden domain 'billing' from 'ordering'.
     ▶ OFFENDING IMPORT: ../billing/billing.service
     ▶ RULE: forbidden_dependency
     ▶ REQUIRED ACTION: Decouple this dependency. Use an authorized Interface, Event, or Shared Kernel.
     ```
   * **STDOUT:** Mengirimkan kontrak IPC JSON:
     ```json
     { "decision": "deny", "reason": "Proposed code imports forbidden domain 'billing' from 'ordering'." }
     ```
   * **Exit Code:** Mengembalikan kode keluar `1` (standar Unix) atau `2` (standar Claude Code / Cursor hooks).

### B. Post-Write Hook (`runPostWriteHook`)
Setelah tool call berhasil menulis kode yang sah ke disk:
* Hook mengeksekusi:
  ```sh
  septum sync >/dev/null 2>&1 &
  ```
* Sinkronisasi berjalan di *background process* (non-blocking). Indeks AST pada `.septum/septum.db` langsung diperbarui secara inkremental tanpa membuat agent terdiam menunggu.

---

## 4. Kompatibilitas Lintas AI Harness & Git

Konfigurasi hooks Septum dibuat otomatis melalui template [hooks.ts](../../src/cli/templates/hooks.ts) untuk mendukung berbagai environment:

| Platform | Integrasi & Protokol |
|---|---|
| **Google Antigravity IDE / Gemini** | Menggunakan konfigurasi `PreToolUse` dan `PostToolUse` berbasis kontrak JSON IPC (`{ decision: "allow" | "deny" }`). |
| **Claude Code & Cursor** | Menggunakan flag `--exit-code-2` atau `--claude` / `--cursor` agar harness agent menangkap kegagalan tool dan meminta LLM mengoreksi arsitektur secara mandiri. |
| **Git Pre-Commit Hook** | Dapat dipasang di `.git/hooks/pre-commit` dengan mengeksekusi `septum check --staged` untuk memblokir `git commit` jika ada pelanggaran arsitektur manual oleh developer manusia. |

---

## 5. Ringkasan Nilai Bisnis Hooks

1. **Jaminan Nol Pelanggaran di Disk (*Zero Contamination*):** Kode yang melanggar arsitektur tidak akan pernah tersimpan di disk.
2. **Umpan Balik Instan (*Zero Latency Feedback*):** AI agent langsung menerima alasan mengapa kodenya ditolak dalam hitungan milidetik, lengkap dengan rekomendasi perbaikan (*Decouple dependency via Interface/Event*).
3. **Indeks Selalu Segar (*Always-Fresh SSOT*):** Post-write hook menjamin database SQLite selalu selaras dengan kondisi file fisik terbaru.
