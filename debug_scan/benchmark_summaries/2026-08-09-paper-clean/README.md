# Benchmark 2026-08-09 paper-clean grayscale

Input: `IMG_6375.jpeg` from App 2 scan-restoration feedback loop.

Changes tested:
- grayscale tone preservation instead of hard 0/255 output
- high-pass/detail-gated ink mask
- `cleanRestoredPaper()` post-pass: keeps gray antialias pixels only near local dark ink cores and bleaches isolated paper grain
- default App-2 profile switched to `soft` after benchmark ranking/visual inspection

Best current profile: `soft`.

Run command:

```bash
npm run scan:bench -- debug_scan/scan_2026-08-09T07-43-29-775Z_IMG_6375.jpeg/00_input_1_IMG_6375.jpeg debug_scan/agent_bench_clean
```
