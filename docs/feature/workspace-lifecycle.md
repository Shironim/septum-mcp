# Feature SSOT: Workspace Lifecycle, SQLite Database & Invalidation Engine

## 1. Latar Belakang & Kebutuhan Bisnis (Business Requirements)

Sebagai mesin analisis kode statis backend, tantangan terbesar Septum adalah **menjamin kesegaran data (*data freshness*)** tanpa membebani performa CPU dan I/O disk.
1. **Pencegahan Data Usang (*Zero Stale State*):** Jika developer mengedit berkas di editor, agent tidak boleh menerima nomor baris yang sudah bergeser atau nama fungsi yang sudah dihapus.
2. **Efisiensi Sinkronisasi (*Incremental Sync*):** Mem-parse ulang seluruh repository pada setiap perubahan 1 berkas adalah pemborosan besar. Septum harus mampu mengisolasi hanya berkas yang berubah.
3. **Penanganan Dependensi Transitif & File Tipe:** Jika berkas tipe eksternal (`types.ts`) atau *barrel file* (`index.ts`) diedit, konsumennya harus otomatis diperbarui atau ditandai usang.
4. **Respon Terhadap Konfigurasi Global:** Perubahan pada konfigurasi proyek (seperti path alias `@/` di `tsconfig.json` atau namespace PSR-4 di `composer.json`) harus otomatis memicu evaluasi ulang graf impor secara bersih.

---

## 2. Arsitektur Database Tersemat SQLite (`septum.db`)

Septum menggunakan database SQLite tersemat beralamat di `.septum/septum.db` yang berjalan dalam mode **WAL (Write-Ahead Logging)** untuk mendukung pembacaan paralel berkecepatan tinggi:

* **Tabel `domains`:** Menyimpan daftar bounded context, folder root, serta aturan dependensi (`allowed_deps_json`, `forbidden_deps_json`, `archetypes_json`).
* **Tabel `files`:** Menyimpan metadata berkas, archetype, content hash SHA-256 (`content_hash`), jumlah baris, ukuran berkas, dan waktu modifikasi (`mtime_ms`).
* **Tabel `symbols`:** Menyimpan tabel symbol hasil parsing Tree-Sitter (nama, jenis, signature, visibilitas, `line_start`, `line_end`).
* **Tabel `dependencies`:** Menyimpan graf impor antar berkas (`source_file_id`, `target_symbol_or_path`, `import_statement`, `is_external`).
* **Tabel `vertical_slices`:** Menyimpan cache rantai eksekusi vertikal route-to-database hasil analisis semantik.
* **Tabel `repo_meta`:** Menyimpan metadata global, termasuk revisi konfigurasi, fingerprint parser, dan status sinkronisasi.

---

## 3. Penanganan Kasus Khusus: Tipe & Barrel Files (*Transitive Invalidation*)

### Skenario Masalah:
Sebuah Service backend `UserService.ts` mengimpor `UserDTO` dari file tipe `types.ts` atau melalui *barrel export* `index.ts`. Developer mengubah `types.ts` (misal menambahkan field `role: string`), tetapi tidak menyentuh `UserService.ts`.

### Solusi Septum:
```
types.ts / index.ts (Berubah di disk)
       │
       ▼
1. File Watcher / Incremental Hashing
       │  └── Hash types.ts berubah di tabel `files`
       │  └── Menandai flag `slices_dirty = 1` di SQLite database
       │
2. Dual-Layer Edge Invalidation (`dependencies` & `import_relationships`)
       │  └── Edge relasi UserService -> types.ts ditandai `freshness: "stale"`
       │
3. Stale-Reference Refusal
       │  └── Jika agent memanggil symbol dengan hash lama,
       │      Septum menolak: `status: "stale_reference"` & meminta sinkronisasi
       │
4. Dynamic On-The-Fly AST Binding (`retrieveContext`)
       └── Parser memuat AST types.ts terkini secara in-memory
       └── Menghasilkan `type_contract` baru yang langsung mencerminkan field baru!
```

1. **Edge Freshness Tracking:** Setiap relasi di tabel `dependencies` dan `import_relationships` mengikat `indexed_content_hash`. Saat query konteks berjalan, Septum membandingkan hash riil disk dengan hash indeks. Jika berbeda, status relasi otomatis menjadi `freshness: "stale"`.
2. **Penolakan Stale Reference:** Septum menolak mengembalikan data jika referensi sudah usang, mengembalikan `status: "stale_reference"`, sehingga agent tidak akan pernah berhalusinasi menggunakan kontrak tipe yang lama.
3. **Dynamic AST Binding:** Saat fungsi di `UserService.ts` diminta, engine `context` membaca isi fisik `types.ts` yang baru secara langsung dan mengekstrak kontrak `type_contract` mutakhir tanpa jeda.

---

## 4. Penanganan Perubahan Konfigurasi Global (*Config Fingerprint*)

### Skenario Masalah:
Developer mengubah konfigurasi proyek seperti `tsconfig.json` (alias `@/*` diarahkan ulang), `composer.json` (PSR-4 autoload prefix berubah), `go.mod`, atau `pyproject.toml`.

### Solusi Septum:
Septum menggunakan **Manifest Hashing Engine** dan **Multi-Tier Cryptographic Revisions**:

1. **Manifest Hashing Map (`manifests`):**
   Setiap kali file manifes dibaca (`tsconfig.json`, `composer.json`, `go.mod`, dll.), Septum menghitung hash kontennya dan menyimpannya di memori:
   ```typescript
   manifests[path.relative(this.root, file)] = computeContentHash(text);
   ```
   Mendukung penelusuran rekursif `extends` pada `tsconfig.json` (misal `tsconfig.base.json`).
2. **Kalkulasi `config_revision` Deterministik:**
   Hasil resolusi impor mengikat token revisi:
   $$\text{config\_revision} = \text{SHA256}(\text{root} + \text{RESOLVER\_REVISION} + \text{manifests})$$
   Jika ada satu karakter saja yang berubah pada manifes konfigurasi, `config_revision` otomatis berubah total.
3. **Multi-Tier Revisions:**
   * `PARSER_FINGERPRINT`: Hash kompilasi kode parser Tree-Sitter + aset WASM.
   * `SEMANTIC_FINGERPRINT`: Hash revisi kode extractor semantik (12 framework).
   * `RESOLVER_REVISION`: Versi logika path & alias resolver.
4. **Automatic Clean Rebuild & Cache Flush:**
   Jika salah satu revisi atau konfigurasi global tidak cocok dengan yang tersimpan di tabel `repo_meta`:
   * Cache rute lama dibersihkan (`clearVerticalSlices()`).
   * Flag `slices_dirty` diset ke `"1"`.
   * `TopologyDetector.detect()` dijalankan ulang untuk memetakan topologi baru.
   * Seluruh graf resolusi impor diindeks ulang dari kondisi bersih (*clean state*).

---

## 5. Mekanisme File Watcher & JIT Delta Sync

Untuk meminimalkan beban sistem, Septum membagi sinkronisasi menjadi dua mode:

1. **Workspace Watcher Terikat Kuota (*Bounded Watch Budget*):**
   * Menggunakan `fs.watch` native dengan alokasi batas watcher aman untuk mencegah *file descriptor exhaustion* (EMFILE).
   * Jika batas watch tercapai, otomatis berpindah ke mode *bounded polling fallback*.
2. **Just-In-Time (JIT) Delta Sync on Query:**
   * Saat `septum_slice` atau `septum_symbol` dipanggil, jika terdeteksi `slices_dirty === "1"` atau ada input yang berubah, Septum mengeksekusi re-trace cepat dalam satu transaksi database SQLite.
   * Agent selalu mendapatkan data yang konsisten dan akurat tanpa perlu melakukan restart server manual.
