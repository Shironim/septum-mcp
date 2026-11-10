# Feature SSOT: `septum_symbol` (AST Symbol Intelligence & Blast Radius)

## 1. Latar Belakang & Kebutuhan Bisnis (Business Requirements)

AI Coding Agent yang melakukan modifikasi kode sering kali mengalami 3 kendala utama:
1. **Buta Koordinat:** Agent kesulitan menemukan letak persis fungsi atau class tanpa melakukan brute-force `grep`, terutama jika terdapat nama fungsi yang sama di berbagai file.
2. **Konteks Berlebihan (*Token Bloat*) atau Kosong (*Hollow Slicing*):** Jika agent membaca seluruh file controller (500–1.000 baris), token window cepat habis. Namun jika agent hanya membaca 3 baris fungsi delegasi (`return this.service.handle()`), agent tidak memahami logika bisnisnya.
3. **Risiko Regresi (*Blind Refactoring*):** Mengubah parameter fungsi publik tanpa mengetahui siapa saja pemanggil fungsi tersebut di seluruh proyek sering kali merusak modul lain.

`septum_symbol` adalah antarmuka utama kecerdasan symbol AST yang menyediakan 3 sub-operasi (*actions*): `locate`, `context`, dan `impact`.

---

## 2. Sub-Operasi 1: `action: "locate"` (Pencarian Koordinat Presisi)

### Cara Kerja Internal & Algoritma
1. **Error Log & Stack-Trace Parser:**
   AI agent dapat memasukkan string pesan error mentah dari terminal. Parser otomatis mengurai container class dan method ([symbol-locator.ts](../../src/core/resolver/symbol-locator.ts)):
   * `"Call to undefined method App\Http\Controllers\OrderController::calculateTotal()"` $\to$ Container: `OrderController`, Member: `calculateTotal`.
   * `"'OrderService' object has no attribute 'calculate_total'"` $\to$ Container: `OrderService`, Member: `calculate_total`.
   * Sintaks bebas: `OrderController::store`, `OrderService->calculateTotal`, `OrderService.calculateTotal`, atau plain `calculateTotal`.
2. **Multi-Signal Similarity Engine (0.0 – 1.0):**
   Jika terjadi salah ketik (*typo*), Septum menghitung skor kemiripan menggabungkan:
   * **Damerau-Levenshtein Distance:** Menangani kesalahan ketik huruf dan transposisi karakter.
   * **Token Jaccard Similarity:** Memecah identifier berdasarkan *CamelCase*, *snake_case*, *kebab-case*, dan namespace.
   * **Prefix & Substring Bonus:** Memberikan bobot tinggi untuk pencarian parsial.
3. **Sibling Methods & Suggestions:**
   Jika symbol tidak ditemukan di class target, Septum mengembalikan daftar `sibling_methods` (method lain yang tersedia pada class tersebut).
4. **Just-In-Time (JIT) Delta Sync:**
   Jika file telah berubah di disk sejak indeks terakhir, Septum langsung mem-parse ulang file tersebut *on-the-fly* agar koordinat nomor baris (`start_line` dan `end_line`) tidak meleset.

### Skema Input & Output JSON
```json
// Request
{
  "action": "locate",
  "query": "OrderController::calculateTotal"
}

// Response
{
  "found": true,
  "query": "OrderController::calculateTotal",
  "file_path": "app/Http/Controllers/OrderController.php",
  "container_name": "OrderController",
  "exact_symbol": {
    "name": "calculateTotal",
    "kind": "method",
    "signature": "public function calculateTotal(OrderRequest $request): JsonResponse",
    "visibility": "public",
    "start_line": 52,
    "end_line": 78,
    "total_lines": 27
  },
  "complexity_smell": {
    "is_high_complexity": false,
    "threshold": 120,
    "total_lines": 27
  },
  "sibling_methods": ["index", "store", "show", "cancel"]
}
```

---

## 3. Sub-Operasi 2: `action: "context"` (Bounded Slicing & DTO Extraction)

### Cara Kerja Internal & Algoritma
1. **Bounded Source Slicing:**
   Hanya mengekstrak baris kode fungsi yang diminta (default limit 120 baris, max 200 baris) dengan batas memori ketat (16 KB) guna menghemat kuota context window AI agent.
2. **Anti-Hollow Slicing (1-Hop Transitive Delegator Expansion):**
   Jika suatu method hanya berupa satu baris delegasi ke service yang di-inject via Dependency Injection:
   ```php
   public function calculate(OrderRequest $request) {
       return $this->orderService->calculateTotal($request->validated());
   }
   ```
   Septum secara cerdas menganalisis parameter Constructor DI, melacak letak class `OrderService`, dan **otomatis menyertakan potongan implementasi method target** (`delegated_implementation`) dalam respons yang sama tanpa perlu tool call tambahan.
3. **In-Memory TypeScript DTO / Contract Extraction:**
   Pada proyek TypeScript, Septum menjalankan in-memory compiler AST untuk mengekstrak interface/type DTO yang dipakai pada signature fungsi.
4. **Dependency & Outbound Resolution:**
   Menyajikan daftar service yang di-inject (`dependencies_injected`) dan fungsi-fungsi lain yang dipanggil ke luar (`outbound_calls`).

### Skema Input & Output JSON
```json
// Request
{
  "action": "context",
  "symbol": "OrderController::calculateTotal"
}

// Response
{
  "symbol": "OrderController::calculateTotal",
  "kind": "method",
  "file_path": "app/Http/Controllers/OrderController.php",
  "exact_range": {
    "start_line": 52,
    "end_line": 78,
    "total_lines": 27
  },
  "dependencies_injected": ["OrderService", "PaymentGateway"],
  "outbound_calls": ["OrderService.calculateTotal"],
  "resolved_outbound_calls": [
    {
      "symbol": "OrderService.calculateTotal",
      "target_file": "app/Services/OrderService.php",
      "is_resolved": true
    }
  ],
  "source_slice": {
    "status": "current",
    "file_path": "app/Http/Controllers/OrderController.php",
    "start_line": 52,
    "end_line": 78,
    "text": "public function calculateTotal(OrderRequest $request): JsonResponse {\n    $total = $this->orderService->calculateTotal($request->validated());\n    return response()->json(['total' => $total]);\n}",
    "delegated_implementation": {
      "symbol": "OrderService::calculateTotal",
      "file_path": "app/Services/OrderService.php",
      "start_line": 80,
      "end_line": 105,
      "text": "public function calculateTotal(array $payload): float {\n    // Implementasi logika kalkulasi riil di Service...\n}"
    }
  }
}
```

---

## 4. Sub-Operasi 3: `action: "impact"` (Blast Radius & Inbound Callers)

### Cara Kerja Internal & Algoritma
1. **Inverse Dependency Traversal:**
   Mencari seluruh file di repository yang mengimpor atau merujuk pada file pendefinisi symbol target.
2. **Batch Enclosing Symbol Resolution (Zero N+1 Query):**
   Septum memuat deklarasi seluruh symbol pada file-file pemanggil dalam 1 kali batch query SQLite, lalu memetakan posisi baris pemanggilan: *“Baris 115 ini berada di dalam method apa?”* Hasilnya adalah nama method pemanggil yang konkret, bukan hanya nomor baris.
3. **Method-Level Invocation Verification:**
   Membedakan antara file yang *hanya mengimpor class* dengan file yang *benar-benar mengeksekusi method tersebut* dengan memvalidasi sintaks pemanggilan:
   * `->methodName(` (PHP)
   * `.methodName(` (TypeScript, JavaScript, Python, Go)
   * `::methodName(` (Static call PHP, C++)
4. **Kalkulasi Tingkat Risiko Regresi (*Risk Level*):**
   * **`low`:** Dipanggil oleh < 2 file dan hanya dalam domain yang sama.
   * **`medium`:** Dipanggil oleh 2–5 file atau melibatkan 2 domain berbeda.
   * **`high`:** Dipanggil oleh > 5 file atau melintasi > 2 domain arsitektur.

### Skema Input & Output JSON
```json
// Request
{
  "action": "impact",
  "symbol": "OrderService::cancelOrder"
}

// Response
{
  "target_symbol": "OrderService::cancelOrder",
  "found_in_index": true,
  "impact_summary": {
    "total_dependents": 3,
    "risk_level": "medium",
    "affected_files_count": 2
  },
  "inbound_callers": [
    {
      "file": "app/Http/Controllers/OrderController.php",
      "caller": "OrderController@cancel",
      "line": 85,
      "kind": "method",
      "domain": "ordering"
    },
    {
      "file": "app/Jobs/ExpireUnpaidOrdersJob.php",
      "caller": "ExpireUnpaidOrdersJob@handle",
      "line": 42,
      "kind": "method",
      "domain": "ordering"
    },
    {
      "file": "app/Http/Controllers/Admin/OrderAdminController.php",
      "caller": "OrderAdminController@forceCancel",
      "line": 120,
      "kind": "method",
      "domain": "admin"
    }
  ]
}
```

---

## 5. Dukungan Bahasa Pemrograman

`septum_symbol` mendukung penuh navigasi AST pada:
* **TypeScript & JavaScript:** Class, method, arrow function, interface, type alias, enum.
* **PHP (Laravel & Symfony):** Class, Trait, Interface, Enum, Constructor Property Promotion (PHP 8), Attributes.
* **Python (FastAPI, Django, Flask):** Class, async/sync def, Pydantic models.
* **Go (Golang):** Struct, Interface, standalone function, method receiver (`func (s *Service) Method()`).
* **Rust, C#, Java, Ruby:** Mendukung pencarian deklarasi struct/class/method secara native via Tree-Sitter grammar WASM.
