# Feature SSOT: `septum_boundary` (Architectural Boundary & Circular Dependency Guard)

## 1. Latar Belakang & Kebutuhan Bisnis (Business Requirements)

AI Coding Agent cenderung berfokus pada penyelesaian tugas lokal (membuat kode berfungsi) tanpa mempertimbangkan integritas arsitektur jangka panjang. Hal ini sering menimbulkan **Architectural Drift**:
1. **Kebocoran Batas Modul (*Boundary Leaks*):** Domain yang seharusnya terisolasi (misal *Ordering*) mengimpor langsung service dari domain lain (*Billing*), melanggar aturan *Dependency Inversion* dan *Hexagonal/Clean Architecture*.
2. **Ketergantungan Melingkar (*Circular Dependencies*):** File A mengimpor File B, dan File B mengimpor kembali File A, menyebabkan runtime failure, memory leak, atau masalah inisialisasi modul.

`septum_boundary` bertindak sebagai **Circuit Breaker Arsitektural** berbasis AST yang memverifikasi kepatuhan import sebelum dan sesudah kode ditulis.

---

## 2. Empat Aturan Pelanggaran (*Violation Rules*)

Engine `BoundaryEvaluator` ([evaluator.ts](../../src/core/boundary/evaluator.ts)) mengevaluasi 4 aturan inti:

### 1. `forbidden_dependency` (Pelanggaran Keras)
Dinyatakan jika sebuah domain secara eksplisit dilarang mengimpor domain target dalam konfigurasi:
```json
{
  "domains": {
    "ordering": {
      "forbidden_dependencies": ["billing"]
    }
  }
}
```
Jika file di dalam `ordering` mengimpor file di dalam `billing`, Septum langsung menolak dan mewajibkan penggunaan event/messaging atau shared interfaces.

### 2. `disallowed_dependency` (Mode Strict)
Jika `settings.enforcement = "strict"`, sebuah domain **hanya diizinkan** mengimpor domain yang terdaftar dalam `allowed_dependencies`. Semua impor ke domain lain di luar daftar tersebut dianggap pelanggaran.

### 3. `circular_dependency` (Deteksi Ketergantungan Melingkar)
Mendeteksi siklus impor menggunakan algoritma Depth-First Search (DFS):
* **Domain Cycles:** Domain A $\to$ Domain B $\to$ Domain A.
* **File Cycles:** `serviceA.ts` $\to$ `serviceB.ts` $\to$ `serviceA.ts`.
* **Smart Type-Only Import Erasure:** Septum mengabaikan import tipe (`import type { ... }` di TypeScript) dari deteksi circular, karena tipe tersebut dihapus (*erased*) saat kompilasi dan tidak menimbulkan siklus saat runtime.

### 4. `unmapped_domain`
Terjadi jika suatu berkas kode mengimpor path internal yang berada di luar domain yang diakui oleh konfigurasi proyek.

---

## 3. Tiga Cakupan Operasi (*Scopes*)

### A. Pre-Flight Proposal Mode (`scope: "file"`)
Digunakan oleh AI agent **sebelum mengedit file di disk** untuk mensimulasikan apakah penambahan import tertentu sah secara arsitektur:

```json
// Request
{
  "file_path": "src/modules/ordering/order.service.ts",
  "proposed_imports": ["../billing/billing.service"]
}

// Response (Ditolak)
{
  "status": "rejected",
  "total_violations": 1,
  "circular_dependencies_count": 0,
  "violations": [
    {
      "file": "src/modules/ordering/order.service.ts",
      "line": 1,
      "source_domain": "ordering",
      "target_domain": "billing",
      "imported_target": "../billing/billing.service",
      "rule": "forbidden_dependency",
      "message": "Forbidden cross-domain dependency detected: 'ordering' is strictly prohibited from importing domain 'billing'."
    }
  ]
}
```

### B. Git Staged Audit Mode (`scope: "staged"`)
Memeriksa hanya file-file yang berada di git staging area (`git add`) sebelum commit ([staged-auditor.ts](../../src/core/boundary/staged-auditor.ts)).
* Sangat cepat karena mengabaikan ratusan file lain yang tidak diubah.
* Memastikan bahwa commit baru tidak membawa *circular dependency* atau pelanggaran arsitektur baru.

```json
// Request
{ "scope": "staged" }

// Response (Disetujui)
{
  "status": "approved",
  "scope": "staged",
  "total_checked": 3,
  "total_violations": 0,
  "circular_dependencies": [],
  "domain_violation_breakdown": {},
  "violations": [],
  "message": "All 3 staged file(s) approved. No boundary violations detected."
}
```

### C. Full Codebase / Domain Scope (`scope: "all"` atau `scope: "domain"`)
Menjalankan audit komprehensif pada seluruh dependency graph di database SQLite untuk memastikan kesehatan arsitektur repository secara berkala.
