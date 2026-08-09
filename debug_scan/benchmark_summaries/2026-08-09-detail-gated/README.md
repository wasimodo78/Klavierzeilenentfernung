# Benchmark 2026-08-09 detail-gated grayscale

Input: `IMG_6375.jpeg` from the App-2 scan-restoration feedback loop.

Purpose: agent-side automated comparison after switching from broad local darkness to detail/high-pass gated grayscale restoration.

Result: major reduction of paper-fold amplification compared with the previous grayscale benchmark. `soft` and `balanced` ranked best by the current heuristic.

Run command:

```bash
npm run scan:bench -- debug_scan/scan_2026-08-09T07-27-09-042Z_IMG_6375.jpeg/00_input_1_IMG_6375.jpeg debug_scan/agent_bench_detail
```
