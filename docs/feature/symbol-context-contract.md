# Feature SSOT: Symbol Context & In-Memory TypeScript Compiler Host

## 1. Latar Belakang & Kebutuhan Bisnis (Business Requirements)

Tujuan utama dari action `context` pada `septum_symbol` adalah memberikan potongan kode implementasi beserta **kontrak deklarasi tipe/DTO** tanpa memasukkan seluruh isi repository atau dependensi raksasa `node_modules` ke dalam context window model AI:
1. **Separation of Evidence:** File, import, pemanggilan method (*calls*), dan type contract memiliki bobot bukti yang berbeda.
2. **Keterikatan Memori & Budget Ketat:** Menghindari pemborosan token dengan memberlakukan batas budget byte yang ketat (default: 16 KiB, rentang 2 KiB – 2 MiB) serta fragmentasi berhalaman (*continuation*).
3. **Pemberian Kontrak Publik Tipe:** Alih-alih menyertakan body method atau field privat dari class penunjang, Septum memproyeksikan kontrak publik instance (*Public Instance Signatures*) dari class/DTO terkait.

---

## 2. Kebijakan Pengambilan Konteks (`referenced-typescript-declarations/v4`)

Implementasi diatur oleh engine [context.ts](../../src/core/retrieval/context.ts) dan [typescript-references.ts](../../src/core/retrieval/typescript-references.ts):

1. **Dukungan Format Berkas:**
   Mendukung target `.ts`, `.mts`, dan `.cts`. Untuk format lain (`.php`, `.py`, `.go`), pemanggilan dialihkan ke mode *bounded inspection* (`source_start_line`, `source_line_limit`).
2. **Span Baris & Hashing yang Presisi:**
   Mengambil implementasi target dengan span baris 1-based inklusif dan hash konten yang diverifikasi langsung terhadap disk. Deklarasi yang melebihi batas budget dikirimkan sebagai fragment yang dapat direkonstruksi melalui token `continuation`.
3. **In-Memory TypeScript Compiler Host:**
   Septum membuat program compiler TypeScript secara *in-memory* (`noLib: true`, `noResolve: true`) tanpa membaca disk berulang kali atau memuat library global.
4. **Penelusuran Referensi Lokal & Import Bindings:**
   Engine memetakan identifier deklarasi lokal, helper function, constant, dan import binding bernama (*named*), alias, default, serta *type-only*. Penelusuran dibatasi hingga 3 hop edge import (maksimum 64 berkas, 256 item, dan total 8 MiB source).
5. **Type-Only Class Signature Projection:**
   Class pendukung yang diimpor sebagai tipe diproyeksikan menjadi interface kontrak publik:
   * Constructor body, member private/protected/static, dan initializers dihilangkan.
   * Public properties, methods, accessors, dan constructor-promoted parameters dipertahankan.
   * Tipe yang tidak diketahui atau inferred ditandai secara konservatif sebagai `unknown`.
6. **Pruning Cabang Call Arguments:**
   Jika argumen pemanggilan lokal bernilai literal yang diketahui, binder memangkas cabang `if`/ternary yang tidak mungkin dieksekusi (*dead branches*), menghasilkan konteks yang sangat bersih bagi AI agent.

---

## 3. Format Pemanggilan & Skema Opsi

```json
{
  "action": "context",
  "query": "submitOrder",
  "file_path": "src/services/order.service.ts",
  "budget_bytes": 32768
}
```

### Opsi Konfigurasi:
* `budget_bytes`: Batas kuota byte keluaran (default: 16.384 bytes, rentang 2.048 – 2.097.152 bytes).
* `continuation`: Token base64url untuk mengambil halaman potongan konteks berikutnya jika deklarasi melebihi budget.
* `include_source`: Menentukan apakah source code fungsi disertakan (default: `true`).
* `source_line_limit`: Batas maksimum baris source code (default: 120 baris).

---

## 4. Struktur Output Context Items

Hasil yang dikembalikan ke AI agent disusun secara terstruktur:

1. **`source`:** Potongan implementasi target dan helper lokal yang dirujuk langsung (`reason: "target_implementation"` atau `"local_dependency"`).
2. **`type_contract`:** Proyeksi kontrak publik antarmuka dari class/DTO yang diimpor (`projection: "public_instance_signatures"`).
3. **`relationship`:** Informasi edge import yang relevan dari berkas target ke modul lain.
4. **`selection`:** Diagnostik pemangkasan cabang berdasarkan nilai argumen yang terverifikasi (`known_call_arguments`).
5. **`diagnostic`:** Peringatan eksplisit jika terdapat batasan kapasitas (`analysis_file_limit`, `side_effect_import_not_expanded`, atau `source_differs_from_index`).

---

## 5. Hubungan dengan Fitur Septum Lainnya

* [septum-symbol.md](./septum-symbol.md): Mendefinisikan antarmuka publik MCP untuk pemanggilan action `locate`, `context`, dan `impact`.
* [workspace-lifecycle.md](./workspace-lifecycle.md): Mengatur siklus hidup SQLite, content hashing, serta pembatalan cache saat file tipe eksternal (`types.ts`) atau barrel files (`index.ts`) dimodifikasi.
