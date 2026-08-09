import { createCanvas, loadImage, Image } from '@napi-rs/canvas';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  downscale,
  GRAYSCALE_PROFILES,
  GrayscaleProfileName,
  restoreScanImage,
} from '../src/utils/scanRestorer';

// Minimaler DOM-Shim für scanRestorer.ts im Node-Harness.
(globalThis as any).document = {
  createElement(tag: string) {
    if (tag !== 'canvas') throw new Error(`Unsupported element: ${tag}`);
    return createCanvas(1, 1);
  },
};
(globalThis as any).Image = Image;

type Metrics = {
  width: number;
  height: number;
  p50: number;
  p90: number;
  p97: number;
  darkPct: number;
  inkPct: number;
  grayEdgeRatio: number;
  blackCoreRatio: number;
  tinyComponentsPerMP: number;
  score: number;
};

type VariantResult = {
  profile: GrayscaleProfileName;
  file: string;
  debugFile: string;
  metrics: Metrics;
  stageLabels: string[];
};

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

function percentileFromHist(hist: Uint32Array, q: number, total: number): number {
  const target = Math.max(1, Math.floor(total * q));
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= target) return i;
  }
  return 255;
}

function tinyComponents(canvas: HTMLCanvasElement): number {
  const small = downscale(canvas, 1400, true);
  const w = small.width, h = small.height;
  const d = small.getContext('2d')!.getImageData(0, 0, w, h).data;
  const bin = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    if (l < 175) bin[p] = 1;
  }
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  let tiny = 0;
  for (let p = 0; p < bin.length; p++) {
    if (!bin[p] || seen[p]) continue;
    let count = 0;
    stack.push(p); seen[p] = 1;
    while (stack.length) {
      const cur = stack.pop()!;
      count++;
      const x = cur % w, y = Math.floor(cur / w);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const np = ny * w + nx;
          if (bin[np] && !seen[np]) { seen[np] = 1; stack.push(np); }
        }
      }
      if (count > 80) stack.length = 0; // kein Speckle mehr, abbrechen
    }
    if (count > 0 && count <= 5) tiny++;
  }
  return tiny / ((w * h) / 1_000_000);
}

function evaluate(canvas: HTMLCanvasElement): Metrics {
  const sample = downscale(canvas, 1600, true);
  const w = sample.width, h = sample.height;
  const d = sample.getContext('2d')!.getImageData(0, 0, w, h).data;
  const hist = new Uint32Array(256);
  let dark = 0, ink = 0, gray = 0, blackCore = 0;
  const total = w * h;
  for (let i = 0; i < d.length; i += 4) {
    const l = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    hist[l]++;
    if (l < 90) dark++;
    if (l < 235) ink++;
    if (l > 18 && l < 235) gray++;
    if (l < 45) blackCore++;
  }
  const p50 = percentileFromHist(hist, 0.50, total);
  const p90 = percentileFromHist(hist, 0.90, total);
  const p97 = percentileFromHist(hist, 0.97, total);
  const tinyPerMP = tinyComponents(sample as unknown as HTMLCanvasElement);

  const inkPct = ink / total;
  const darkPct = dark / total;
  const grayEdgeRatio = gray / Math.max(1, ink);
  const blackCoreRatio = blackCore / Math.max(1, ink);

  // Heuristik ohne Ground Truth:
  // - Papier soll sehr hell sein.
  // - Es soll genug Graukante geben (nicht binär/pixelig), aber nicht alles grau/matschig.
  // - Es soll schwarze Kerne geben (Druck bleibt lesbar).
  // - Kleine isolierte Komponenten sind meist Rauschen/JPEG-Dreck.
  const paperScore = clamp((p90 - 230) / 24, 0, 1);
  const edgeScore = clamp(1 - Math.abs(grayEdgeRatio - 0.42) / 0.34, 0, 1);
  const coreScore = clamp(1 - Math.abs(blackCoreRatio - 0.28) / 0.28, 0, 1);
  const inkScore = clamp(1 - Math.abs(inkPct - 0.16) / 0.16, 0, 1);
  const speckleScore = clamp(1 - tinyPerMP / 450, 0, 1);
  const score = 100 * (0.28 * paperScore + 0.28 * edgeScore + 0.20 * coreScore + 0.14 * inkScore + 0.10 * speckleScore);

  return { width: canvas.width, height: canvas.height, p50, p90, p97, darkPct, inkPct, grayEdgeRatio, blackCoreRatio, tinyComponentsPerMP: tinyPerMP, score };
}

async function canvasToPngBuffer(canvas: HTMLCanvasElement): Promise<Buffer> {
  const anyCanvas = canvas as any;
  if (typeof anyCanvas.encode === 'function') return Buffer.from(await anyCanvas.encode('png'));
  const dataUrl = canvas.toDataURL('image/png');
  return Buffer.from(dataUrl.split(',', 2)[1], 'base64');
}

function latestInputFromDebugScan(): string | null {
  const root = 'debug_scan';
  if (!existsSync(root)) return null;
  const dirs = readdirSync(root)
    .map(d => path.join(root, d))
    .filter(p => statSync(p).isDirectory())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const dir of dirs) {
    const input = readdirSync(dir).find(f => /^00_input_/.test(f));
    if (input) return path.join(dir, input);
  }
  return null;
}

function makeOutDir(input: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.basename(input).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  return path.join('debug_scan', `agent_bench_${stamp}_${base}`);
}

async function loadInputCanvas(input: string): Promise<HTMLCanvasElement> {
  const img = await loadImage(input);
  const canvas = createCanvas(img.width, img.height) as unknown as HTMLCanvasElement;
  canvas.getContext('2d')!.drawImage(img as any, 0, 0);
  return canvas;
}

async function contactSheet(results: VariantResult[], outDir: string) {
  const thumbW = 420;
  const pad = 18;
  const labelH = 92;
  const cols = Math.min(2, results.length);
  const thumbs = await Promise.all(results.map(async r => {
    const img = await loadImage(path.join(outDir, r.file));
    const scale = thumbW / img.width;
    return { img, w: thumbW, h: Math.round(img.height * scale), r };
  }));
  const cellH = Math.max(...thumbs.map(t => t.h)) + labelH;
  const rows = Math.ceil(results.length / cols);
  const sheet = createCanvas(cols * (thumbW + pad) + pad, rows * (cellH + pad) + pad);
  const ctx = sheet.getContext('2d');
  ctx.fillStyle = '#f8fafc'; ctx.fillRect(0, 0, sheet.width, sheet.height);
  ctx.font = '16px sans-serif';
  for (let i = 0; i < thumbs.length; i++) {
    const col = i % cols, row = Math.floor(i / cols);
    const x = pad + col * (thumbW + pad);
    const y = pad + row * (cellH + pad);
    ctx.fillStyle = 'white'; ctx.fillRect(x, y, thumbW, cellH);
    ctx.drawImage(thumbs[i].img, x, y, thumbW, thumbs[i].h);
    const m = thumbs[i].r.metrics;
    ctx.fillStyle = '#0f172a';
    ctx.fillText(`${thumbs[i].r.profile}  score=${m.score.toFixed(1)}`, x + 8, y + thumbs[i].h + 24);
    ctx.font = '12px monospace';
    ctx.fillStyle = '#334155';
    ctx.fillText(`p90=${m.p90} edge=${m.grayEdgeRatio.toFixed(2)} core=${m.blackCoreRatio.toFixed(2)}`, x + 8, y + thumbs[i].h + 46);
    ctx.fillText(`ink=${(m.inkPct*100).toFixed(1)}% speckles=${m.tinyComponentsPerMP.toFixed(0)}/MP`, x + 8, y + thumbs[i].h + 66);
    ctx.font = '16px sans-serif';
  }
  writeFileSync(path.join(outDir, 'contact_sheet.png'), await sheet.encode('png'));
}

const input = process.argv[2] ?? latestInputFromDebugScan();
if (!input) {
  console.error('Kein Input angegeben und kein debug_scan/*/00_input_* gefunden. Usage: npm run scan:bench -- <bild> [outDir]');
  process.exit(1);
}
const outDir = process.argv[3] ?? makeOutDir(input);
mkdirSync(outDir, { recursive: true });

const profiles = Object.keys(GRAYSCALE_PROFILES) as GrayscaleProfileName[];
const results: VariantResult[] = [];
console.log(`Input: ${input}`);
console.log(`Output: ${outDir}`);
for (const profile of profiles) {
  console.log(`\n== ${profile} ==`);
  const src = await loadInputCanvas(input);
  const pages = await restoreScanImage(src, { grayscaleProfile: profile, includeComparisonStages: false });
  const page = pages[0];
  const resultName = `result_${profile}.png`;
  const debugName = `debug_${profile}.json`;
  writeFileSync(path.join(outDir, resultName), await canvasToPngBuffer(page.canvas));
  const metrics = evaluate(page.canvas);
  const debug = {
    input,
    profile,
    metrics,
    debug: {
      orientationVotes: page.debug.orientationVotes,
      fineAngleDeg: page.debug.fineAngleDeg,
      split: page.debug.split,
      splitColumnX: page.debug.splitColumnX,
      splitEvidence: page.debug.splitEvidence,
      stageLabels: page.debug.stageImages.map(s => s.label),
    },
  };
  writeFileSync(path.join(outDir, debugName), JSON.stringify(debug, null, 2));
  results.push({ profile, file: resultName, debugFile: debugName, metrics, stageLabels: debug.debug.stageLabels });
  console.log(metrics);
}
results.sort((a, b) => b.metrics.score - a.metrics.score);
writeFileSync(path.join(outDir, 'ranking.json'), JSON.stringify({ input, generatedAt: new Date().toISOString(), results }, null, 2));
await contactSheet(results, outDir);
console.log('\nRanking:');
for (const [i, r] of results.entries()) console.log(`${i + 1}. ${r.profile}: ${r.metrics.score.toFixed(1)} (${r.file})`);
console.log(`\nKontaktbogen: ${path.join(outDir, 'contact_sheet.png')}`);
