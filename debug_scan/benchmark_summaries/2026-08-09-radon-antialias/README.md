# Benchmark 2026-08-09 radon antialias

Changes tested:
- min-pooling downsample + directional staff-edge Radon deskew inspired by user-provided pipeline
- ink-edge-only antialiasing pass after paper cleanup

Observation:
- Radon deskew improves global horizontal alignment and reduces speckles in the automated metric.
- Pure supersampling above 1.25x was tested but killed the sandbox due memory pressure, so it is not enabled.
- Remaining stair/wobble artifacts are likely from curved page geometry / local staff curvature, not only binary thresholding.

Best current profile remains `soft`.
