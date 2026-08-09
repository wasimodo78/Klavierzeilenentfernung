// Scan-Restauration: Normalisierung von Fotos/schlechten Scans zu A4.
// Prinzip: Messen → Rektifizieren → Verifizieren. Alle geometrischen Regeln
// in Proportionen (Spatia/Seitenbruchteile), nie in absoluten Pixeln.

export type ScanDebug = {
  orientationVotes: string;
  fineAngleDeg: number;
  split: 'einseitig' | 'doppelseitig';
  splitColumnX: number | null;
  splitEvidence: string;
  stageImages: { label: string, dataUrl: string }[];
};

export type RestoredPage = {
  canvas: HTMLCanvasElement; // normalisierte Seite (Illumination entzerrt)
  debug: ScanDebug;
};

// --- Binarisierung (global, schnell) ---------------------------------------
function binarize(canvas: HTMLCanvasElement): Uint8Array {
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width, h = canvas.height;
  const d = ctx.getImageData(0, 0, w, h).data;
  const bin = new Uint8Array(w * h);
  // Schwellwert grob aus dem Histogramm (Mitte zwischen Peaks, Otsu-ähnlich)
  const hist = new Float64Array(256);
  for (let i = 0; i < d.length; i += 4) hist[Math.floor(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])]++;
  let total = d.length / 4, sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  const mean = sum / total;
  let sumB = 0, wB = 0, maxVar = 0, thr = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (wB === 0) continue;
    const wF = total - wB; if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > maxVar) { maxVar = v; thr = i; }
  }
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    bin[i / 4] = l < thr ? 1 : 0;
  }
  return bin;
}

// --- Hilfs-Helfer: Bitmap drehen (nearest-neighbor, weiss-Auffüllung) --------
function rotateBinary(bin: Uint8Array, w: number, h: number, deg: number): { bin: Uint8Array, w: number, h: number } {
  const rad = deg * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const cx = w / 2, cy = h / 2;
  const cw = Math.ceil(Math.abs(w * cos) + Math.abs(h * sin));
  const ch = Math.ceil(Math.abs(w * sin) + Math.abs(h * cos));
  const out = new Uint8Array(cw * ch);
  const ccx = cw / 2, ccy = ch / 2;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const dx = x - ccx, dy = y - ccy;
      const sx = dx * cos + dy * sin + cx;
      const sy = -dx * sin + dy * cos + cy;
      const xi = Math.round(sx), yi = Math.round(sy);
      if (xi >= 0 && xi < w && yi >= 0 && yi < h) out[y * cw + x] = bin[yi * w + xi];
    }
  }
  return { bin: out, w: cw, h: ch };
}

// --- Groborientierung: 0/90 Grad -------------------------------------------
// Musik hat dominante horizontale Linien; in der falschen Orientierung werden
// aus ihnen kurze/unzureichende Läufe. Miss Staerke langer Läufe beider Lagen.
function horizontalStrength(bin: Uint8Array, w: number, h: number): { score: number, longRuns: number } {
  let score = 0, longRuns = 0;
  const minLong = Math.floor(w * 0.15); // wie MIN_LINE_LENGTH in cvAnalyzer
  for (let y = 0; y < h; y += 3) { // Sampling: jede 3. Zeile reicht
    let run = 0;
    for (let x = 0; x < w; x++) {
      if (bin[y * w + x] === 1) {
        run++;
        if (run === minLong) { longRuns++; score += 1; }
      } else run = 0;
    }
  }
  return { score, longRuns };
}

function transposeBinary(bin: Uint8Array, w: number, h: number): { bin: Uint8Array, w: number, h: number } {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[x * h + y] = bin[y * w + x];
  return { bin: out, w: h, h: w };
}

export function estimateOrientation90(canvas: HTMLCanvasElement): { rotate90: boolean, votes: string } {
  const small = downscale(canvas, 800);
  const bin = binarize(small);
  const w = small.width, h = small.height;
  // Projektive Schärfe: Musik produziert in RICHTIGER Orientierung harte
  // Kontraste zwischen vollen und leeren Zeilen (Staff-Linien + Text),
  // quer dazu schmiert alles auf mittlere Anteile. Kurvenfest: es wird nur
  // gezählt, keine Geradheit verlangt.
  const sharp = (fn: (i: number) => number, n: number): number => {
    let s = 0;
    for (let i = 0; i < n; i += 2) { const v = fn(i); s += v * v; }
    return s;
  };
  const rows = sharp(y => { let b = 0; const o = y * w; for (let x = 0; x < w; x++) b += bin[o + x]; return b; }, h);
  const cols = sharp(x => { let b = 0; for (let y = 0; y < h; y++) b += bin[y * w + x]; return b; }, w);
  const votes = `0°=${(rows / 1e9).toFixed(2)} 90°=${(cols / 1e9).toFixed(2)}`;
  return { rotate90: cols > rows * 1.1, votes };
}


// --- Min-Pooling + Staff-Edge-Radon-Deskew ----------------------------------
// Normales Canvas-Downscaling mittelt 1px-Notenlinien weg. Für die Winkelmessung
// verkleinern wir deshalb per Min-Pooling: jeder Zielpixel übernimmt die dunkelste
// Quell-Luminanz im entsprechenden Block. Dünne horizontale Stafflinien bleiben
// sicher erhalten.
type GrayMinPool = { gray: Uint8Array; w: number; h: number; scale: number };

type EdgePoint = { x: number; y: number; weight: number };

function minPoolGrayscale(canvas: HTMLCanvasElement, maxDim = 1200): GrayMinPool {
  const sw = canvas.width, sh = canvas.height;
  const scale = Math.min(1, maxDim / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const d = canvas.getContext('2d')!.getImageData(0, 0, sw, sh).data;
  const gray = new Uint8Array(w * h);

  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor(y / scale);
    const sy1 = Math.min(sh - 1, Math.max(sy0, Math.ceil((y + 1) / scale) - 1));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor(x / scale);
      const sx1 = Math.min(sw - 1, Math.max(sx0, Math.ceil((x + 1) / scale) - 1));
      let minL = 255;
      for (let sy = sy0; sy <= sy1; sy++) {
        for (let sx = sx0; sx <= sx1; sx++) {
          const i = (sy * sw + sx) * 4;
          const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          if (l < minL) minL = l;
        }
      }
      gray[y * w + x] = minL;
    }
  }
  return { gray, w, h, scale };
}

function extractHorizontalStaffEdges(mp: GrayMinPool): EdgePoint[] {
  const { gray, w, h } = mp;
  const pts: EdgePoint[] = [];
  const step = Math.max(1, Math.floor(Math.max(w, h) / 1600));
  for (let y = 1; y < h - 1; y += step) {
    for (let x = 1; x < w - 1; x += step) {
      const i = y * w + x;
      const dy = Math.abs(gray[i + w] - gray[i - w]);
      const dx = Math.abs(gray[i + 1] - gray[i - 1]);
      // Vertikaler Gradient = Kante einer horizontalen Linie. Die lokale
      // Helligkeitsschranke entfernt viel Papiertextur, erhält aber blasse Linien.
      if (dy > 24 && dy > dx * 1.18 && gray[i] < 246) {
        pts.push({ x, y, weight: Math.min(4, 1 + dy / 48) });
      }
    }
  }

  // Performance-Kappe deterministisch: jedes n-te Pixel, nicht random.
  const maxPts = 180_000;
  if (pts.length <= maxPts) return pts;
  const stride = Math.ceil(pts.length / maxPts);
  return pts.filter((_, i) => i % stride === 0);
}

function radonSharpness(points: EdgePoint[], w: number, h: number, deg: number): number {
  const rad = deg * Math.PI / 180;
  const sin = Math.sin(rad), cos = Math.cos(rad);
  const minY = Math.min(0, w * sin, h * cos, w * sin + h * cos) - 2;
  const maxY = Math.max(0, w * sin, h * cos, w * sin + h * cos) + 2;
  const bins = new Float64Array(Math.ceil(maxY - minY) + 4);
  for (const p of points) {
    const yr = p.x * sin + p.y * cos;
    const b = Math.round(yr - minY);
    if (b >= 0 && b < bins.length) bins[b] += p.weight;
  }
  let score = 0;
  for (let i = 1; i < bins.length; i++) {
    const d = bins[i] - bins[i - 1];
    score += d * d;
  }
  return score;
}

function bestRadonAngle(points: EdgePoint[], w: number, h: number): { angleDeg: number; votes: string } {
  if (points.length < 200) return { angleDeg: 0, votes: `zu wenige Staff-Kanten (${points.length})` };
  let best = 0;
  let bestScore = -Infinity;
  const coarseVotes: string[] = [];
  const test = (a: number) => {
    const s = radonSharpness(points, w, h, a);
    if (s > bestScore) { bestScore = s; best = a; }
    return s;
  };
  for (let a = -20; a <= 20.0001; a += 0.5) {
    const s = test(a);
    if (Math.abs(a % 2) < 1e-6) coarseVotes.push(`${a.toFixed(0)}°:${(s / 1e6).toFixed(1)}`);
  }
  const cBest = best;
  for (let a = cBest - 0.7; a <= cBest + 0.7001; a += 0.1) test(a);
  const fBest = best;
  for (let a = fBest - 0.16; a <= fBest + 0.1601; a += 0.02) test(a);
  return { angleDeg: best, votes: `edges=${points.length} ${coarseVotes.join(' ')} best=${best.toFixed(3)} score=${(bestScore / 1e6).toFixed(1)}` };
}

// --- Feinwinkel über Projektionsschärfe ------------------------------------
export function rotateCanvas(src: HTMLCanvasElement, deg: number): HTMLCanvasElement {
  const rad = deg * Math.PI / 180;
  const out = document.createElement('canvas');
  out.width = src.width; out.height = src.height;
  const octx = out.getContext('2d')!;
  octx.fillStyle = 'white';
  octx.fillRect(0, 0, out.width, out.height);
  octx.translate(src.width / 2, src.height / 2);
  octx.rotate(rad);
  octx.drawImage(src, -src.width / 2, -src.height / 2);
  return out;
}

function projectionSharpness(canvas: HTMLCanvasElement): number {
  const bin = binarize(canvas);
  const w = canvas.width, h = canvas.height;
  let score = 0;
  for (let y = 0; y < h; y += 2) {
    let rowBlack = 0;
    for (let x = 0; x < w; x++) rowBlack += bin[y * w + x];
    score += rowBlack * rowBlack;
  }
  return score;
}

export function estimateFineAngle(canvas: HTMLCanvasElement): { angleDeg: number, votes: string } {
  const mp = minPoolGrayscale(canvas, 1200);
  const pts = extractHorizontalStaffEdges(mp);
  return bestRadonAngle(pts, mp.w, mp.h);
}


// --- Perspektivische Rektifizierung über Papierkontur -----------------------
// Hintergrund/Ecken: Finde die Papier-Ecken als Extrempunkte der hellen
// Flaeche (Papier hell, Untergrund dunkler). Ecken-Signatur via
// Richtungsmaxima (TL min x+y, TR max x-y, BR max x+y, BL min x-y).
function luminanceGrid(canvas: HTMLCanvasElement): { w: number, h: number, lum: Float32Array } {
  const w = canvas.width, h = canvas.height;
  const d = canvas.getContext('2d')!.getImageData(0, 0, w, h).data;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < d.length; i += 4) lum[i / 4] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return { w, h, lum };
}

export function detectPageCorners(canvas: HTMLCanvasElement): { corners: [number, number][] | null, evidence: string } {
  const small = downscale(canvas, 900);
  const { w, h, lum } = luminanceGrid(small);
  // Helligkeitsschwelle adaptiv (Otsu auf abgetasteter Luminance)
  const hist = new Float64Array(256);
  for (let i = 0; i < lum.length; i += 9) hist[Math.floor(lum[i])]++;
  let total = 0, sum = 0;
  for (let i = 0; i < 256; i++) total += hist[i], sum += i * hist[i];
  const mean = sum / total;
  let sumB = 0, wB = 0, best = 0, thr = 160;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; thr = i; }
  }
  // Papier-Maske: Ränder wegen Fensterlicht nicht disqualifizieren -> robuste
  // Mindesthelligkeit Tiefer 5% vom Mittel
  const paperThr = Math.max(thr, mean * 0.55);
  const paper = new Uint8Array(w * h);
  let totalPaper = 0;
  for (let i = 0; i < lum.length; i++) { if (lum[i] >= paperThr) { paper[i] = 1; totalPaper++; } }
  const minPaper = w * h * 0.10; // mind. 10% der Flaeche Papier, sonst keine Kontur
  if (totalPaper < minPaper) return { corners: null, evidence: `Papieranteil ${(totalPaper / (w * h) * 100).toFixed(1)}% < 10%` };
  // Größte zusammenhängende Papier-Flaeche finden (Flood Fill, reuse)
  const visited = new Uint8Array(w * h);
  let bestComp: { px: number[] } | null = null;
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (!paper[start] || visited[start]) continue;
    const comp: number[] = [];
    stack.push(start); visited[start] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      comp.push(p);
      const px = p % w, py = Math.floor(p / w);
      const neigh = [[px - 1, py], [px + 1, py], [px, py - 1], [px, py + 1]];
      for (const [nx, ny] of neigh) {
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const np = ny * w + nx;
        if (paper[np] && !visited[np]) { visited[np] = 1; stack.push(np); }
      }
    }
    if (!bestComp || comp.length > bestComp.px.length) bestComp = { px: comp };
    if (stack.length > 0) stack.length = 0;
    // Performance: fruehstuecke abbrechen wenn Flaeche gross genug
    if (bestComp && bestComp.px.length > totalPaper * 0.8) break;
  }
  if (!bestComp || bestComp.px.length < totalPaper * 0.5) {
    return { corners: null, evidence: `kein dominierendes Papier-Areal (${bestComp ? (bestComp.px.length / totalPaper * 100).toFixed(0) : 0}% der Flaeche)` };
  }
  // Ecken-Signaturen
  const tl = { s: Infinity, p: -1 }, tr = { s: -Infinity, p: -1 }, br = { s: -Infinity, p: -1 }, bl = { s: Infinity, p: -1 };
  for (const p of bestComp.px) {
    const x = p % w, y = Math.floor(p / w);
    if (x + y < tl.s) { tl.s = x + y; tl.p = p; }
    if (x - y > tr.s) { tr.s = x - y; tr.p = p; }
    if (x + y > br.s) { br.s = x + y; br.p = p; }
    if (x - y < bl.s) { bl.s = x - y; bl.p = p; }
  }
  const toXY = (p: number): [number, number] => [p % w, Math.floor(p / w)];
  if (tl.p < 0 || tr.p < 0 || br.p < 0 || bl.p < 0) return { corners: null, evidence: 'Ecken nicht auffindbar' };
  const src4 = [toXY(tl.p), toXY(tr.p), toXY(br.p), toXY(bl.p)];
  const evidence = `Ecken gefunden: TL(${toXY(tl.p)}) TR(${toXY(tr.p)}) BR(${toXY(br.p)}) BL(${toXY(bl.p)}) Papier ${(bestComp.px.length / totalPaper * 100).toFixed(0)}%, Schwellwert ${paperThr.toFixed(0)}`;
  return { corners: src4, evidence };
}

// Homographie aus 4 Punkten (Dreieck-Interpolation via Doppelbilinear/baryzentrisch)?
// Wir nutzen direkte 4-Punkt-Homographie (DLT-ähnlich, geschlossene Form in 2D->2D via parallelogram or projective warp).
// Einfacher stabil: projektive Warp mit Bilinear-Approximation pro Scanline via Eckinterpolation.
export function rectifyPerspective(canvas: HTMLCanvasElement, corners: [number, number][], outW: number, outH: number): HTMLCanvasElement {
  const [tl, tr, br, bl] = corners;
  // Skalierungsfaktor: corners sind auf downscale-Ebene; auf Original umrechnen
  const small = downscale(canvas, 900);
  const sc = canvas.width / small.width;
  const CTL: [number, number] = [tl[0] * sc, tl[1] * sc];
  const CTR: [number, number] = [tr[0] * sc, tr[1] * sc];
  const CBR: [number, number] = [br[0] * sc, br[1] * sc];
  const CBL: [number, number] = [bl[0] * sc, bl[1] * sc];
  const out = document.createElement('canvas');
  out.width = outW; out.height = outH;
  const octx = out.getContext('2d')!;
  const sctx = canvas.getContext('2d')!;
  const src = sctx.getImageData(0, 0, canvas.width, canvas.height);
  const oimg = octx.createImageData(outW, outH);
  const od = oimg.data, sd = src.data;
  const sw = canvas.width;
  const lerp = (a: [number, number], b: [number, number], t: number): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  for (let y = 0; y < outH; y++) {
    const v = y / (outH - 1);
    const L = lerp(CTL, CBL, v);
    const R = lerp(CTR, CBR, v);
    for (let x = 0; x < outW; x++) {
      const u = x / (outW - 1);
      const [sx, sy] = lerp(L, R, u);
      // bilinear sample
      const x0 = Math.max(0, Math.floor(sx)), y0 = Math.max(0, Math.floor(sy));
      const x1 = Math.min(canvas.width - 1, x0 + 1), y1 = Math.min(canvas.height - 1, y0 + 1);
      const dx = Math.min(1, Math.max(0, sx - x0)), dy = Math.min(1, Math.max(0, sy - y0));
      for (let c = 0; c < 3; c++) {
        const c00 = sd[(y0 * sw + x0) * 4 + c], c10 = sd[(y0 * sw + x1) * 4 + c], c01 = sd[(y1 * sw + x0) * 4 + c], c11 = sd[(y1 * sw + x1) * 4 + c];
        od[(y * outW + x) * 4 + c] = c00 * (1 - dx) * (1 - dy) + c10 * dx * (1 - dy) + c01 * (1 - dx) * dy + c11 * dx * dy;
      }
      od[(y * outW + x) * 4 + 3] = 255;
    }
  }
  octx.putImageData(oimg, 0, 0);
  return out;
}


// --- Hauptseiten-Erkennung in Handyfotos ------------------------------------
// Bei Buch-/Handyfotos ist oft eine zweite Seite oder der Tisch sichtbar. Die
// reine Extrempunkt-Suche auf der hellen Gesamtfläche nimmt dann das ganze Foto.
// Diese Routine sucht zeilenweise den dominanten Papier-Lauf (meist die rechte,
// vollständige Seite), toleriert kleine Tinten-Lücken, aber trennt breite dunkle
// Falze/Tischbereiche. Daraus entsteht ein robuster Seiten-Quadrilateral.
export function detectDominantPageCornersByRuns(canvas: HTMLCanvasElement): { corners: [number, number][] | null, evidence: string } {
  const small = downscale(canvas, 900);
  const { w, h, lum } = luminanceGrid(small);

  // Adaptiver Hell-/Papier-Schwellwert. Nach boost+normalize liegt Papier hoch,
  // aber Schatten/vergilbtes Papier sollen noch dazugehören.
  const hist = new Float64Array(256);
  for (let i = 0; i < lum.length; i += 5) hist[Math.floor(lum[i])]++;
  let total = 0, sum = 0;
  for (let i = 0; i < 256; i++) { total += hist[i]; sum += i * hist[i]; }
  const mean = total ? sum / total : 180;
  let sumB = 0, wB = 0, best = 0, otsu = 150;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; otsu = i; }
  }
  const paperThr = clampNum(Math.max(otsu, mean * 0.62), 105, 210);
  const maxGap = Math.max(6, Math.floor(w * 0.025)); // Tinten-/Noten-Lücken ja, Falz nein
  const minRunW = w * 0.32;

  type RowRun = { y: number; left: number; right: number; width: number };
  const rows: RowRun[] = [];

  for (let y = 0; y < h; y++) {
    const off = y * w;
    let bestRun: RowRun | null = null;
    let start = -1;
    let lastBright = -1;
    let gap = 0;

    const finish = () => {
      if (start < 0 || lastBright < start) return;
      const left = start, right = lastBright;
      const width = right - left + 1;
      const center = (left + right) / 2;
      // Rechte/vollständige Seite bevorzugen; linke Nebenseite ist meist schmaler.
      const score = width * (1 + center / w * 0.18);
      if (width >= minRunW && center >= w * 0.20) {
        const cand = { y, left, right, width };
        const oldScore = bestRun ? bestRun.width * (1 + ((bestRun.left + bestRun.right) / 2) / w * 0.18) : -1;
        if (!bestRun || score > oldScore) bestRun = cand;
      }
    };

    for (let x = 0; x < w; x++) {
      const bright = lum[off + x] >= paperThr;
      if (bright) {
        if (start < 0) start = x;
        lastBright = x;
        gap = 0;
      } else if (start >= 0) {
        gap++;
        if (gap > maxGap) {
          finish();
          start = -1; lastBright = -1; gap = 0;
        }
      }
    }
    finish();
    if (bestRun) rows.push(bestRun);
  }

  if (rows.length < h * 0.25) return { corners: null, evidence: `zu wenige dominante Papier-Zeilen (${rows.length}/${h}, thr=${paperThr.toFixed(0)})` };

  // Längste zusammenhängende Vertikalzone finden; einzelne ausgefallene Zeilen tolerieren.
  const sorted = rows.sort((a, b) => a.y - b.y);
  let bestBand = { a: 0, b: 0, count: 0 };
  let a = 0, lastY = sorted[0].y, count = 1;
  const yGapMax = Math.max(4, Math.floor(h * 0.015));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].y - lastY <= yGapMax) {
      count++;
    } else {
      if (count > bestBand.count) bestBand = { a, b: i - 1, count };
      a = i; count = 1;
    }
    lastY = sorted[i].y;
  }
  if (count > bestBand.count) bestBand = { a, b: sorted.length - 1, count };
  const band = sorted.slice(bestBand.a, bestBand.b + 1);
  if (band.length < h * 0.25) return { corners: null, evidence: `kein stabiles Seitenband (${band.length} Zeilen)` };

  const topY = band[0].y;
  const bottomY = band[band.length - 1].y;
  const bandH = Math.max(1, bottomY - topY + 1);
  const edgeWindow = Math.max(5, Math.floor(bandH * 0.035));
  const median = (vals: number[]) => {
    const v = vals.slice().sort((x, y) => x - y);
    return v.length ? v[Math.floor(v.length / 2)] : 0;
  };
  const nearTop = band.filter(r => r.y <= topY + edgeWindow);
  const nearBottom = band.filter(r => r.y >= bottomY - edgeWindow);

  const tl: [number, number] = [median(nearTop.map(r => r.left)), topY];
  const tr: [number, number] = [median(nearTop.map(r => r.right)), topY];
  const br: [number, number] = [median(nearBottom.map(r => r.right)), bottomY];
  const bl: [number, number] = [median(nearBottom.map(r => r.left)), bottomY];

  const topW = tr[0] - tl[0];
  const bottomW = br[0] - bl[0];
  if (topW < w * 0.25 || bottomW < w * 0.25 || bandH < h * 0.45) {
    return { corners: null, evidence: `Geometrie unplausibel topW=${topW.toFixed(0)} bottomW=${bottomW.toFixed(0)} h=${bandH.toFixed(0)}` };
  }

  return {
    corners: [tl, tr, br, bl],
    evidence: `dominante Hauptseite: Y ${topY}-${bottomY}, X oben ${tl[0].toFixed(0)}-${tr[0].toFixed(0)}, unten ${bl[0].toFixed(0)}-${br[0].toFixed(0)}, thr=${paperThr.toFixed(0)}, Zeilen=${band.length}`
  };
}

// --- Doppelseiten-Erkennung -------------------------------------------------
function columnProfile(canvas: HTMLCanvasElement): Float64Array {
  const bin = binarize(canvas);
  const w = canvas.width, h = canvas.height;
  const prof = new Float64Array(w);
  const stepY = 4;
  for (let x = 0; x < w; x++) {
    let b = 0;
    for (let y = 0; y < h; y += stepY) b += bin[y * w + x];
    prof[x] = b;
  }
  // glätten breit (relativ zur Breite)
  const win = Math.max(5, Math.floor(w * 0.012));
  const smooth = new Float64Array(w);
  for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let k = -win; k <= win; k++) {
      const xx = x + k;
      if (xx >= 0 && xx < w) { s += prof[xx]; n++; }
    }
    smooth[x] = s / n;
  }
  return smooth;
}

export function detectDoublePage(canvas: HTMLCanvasElement): { split: boolean, columnX: number | null, evidence: string } {
  const small = downscale(canvas, 1400);
  const prof = columnProfile(small);
  const { w, h, lum } = luminanceGrid(small);
  const lumProf = new Float64Array(w);
  const stepY = 4;
  for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let y = 0; y < h; y += stepY) { s += lum[y * w + x]; n++; }
    lumProf[x] = s / n;
  }
  const scale = canvas.width / small.width;
  const threshold = 1.7;
  const bandMinFraction = 0.012; // Band muss >= 1.2% der Seitenbreite sein

  const evaluate = (bandX0: number, bandX1: number, valley: number, kind: string): { ratio: number, side: number } => {
    const left = avg(prof, Math.floor(w * 0.15), bandX0 - Math.floor(w * 0.02));
    const right = avg(prof, bandX1 + Math.floor(w * 0.02), Math.floor(w * 0.85));
    const side = Math.min(left, right);
    if (side <= 0) return { ratio: 0, side: 0 };
    // auch beide Lum-Seiten vergleichen (Falz dunkel, Bandweiss/stehend)
    return { ratio: side / Math.max(0.001, valley), side };
  };

  // Tinte-Tal: breiteste Zusammenhangszone UNTER q%-Quantil im Zentrum
  const center = prof.slice(Math.floor(w * 0.42), Math.floor(w * 0.58));
  const sorted = [...center].sort((a, b) => a - b);
  const cutoff = sorted[Math.floor(sorted.length * 0.25)];
  // Bänder finden
  let bestInk = { x: -1, ratio: 0, bandW: 0 };
  let xs = -1;
  for (let x = Math.floor(w * 0.42); x < Math.floor(w * 0.58); x++) {
    if (prof[x] <= cutoff) { if (xs < 0) xs = x; }
    else if (xs >= 0) {
      const bw = x - xs;
      if (bw >= w * bandMinFraction) {
        const v = avg(prof, xs, x - 1);
        const { ratio } = evaluate(xs, x - 1, v, 'ink');
        if (ratio > bestInk.ratio) bestInk = { x: Math.round((xs + x - 1) / 2), ratio, bandW: bw };
      }
      xs = -1;
    }
  }
  if (xs >= 0) {
    const x = Math.floor(w * 0.58);
    const bw = x - xs;
    if (bw >= w * bandMinFraction) {
      const v = avg(prof, xs, x - 1);
      const { ratio } = evaluate(xs, x - 1, v, 'ink');
      if (ratio > bestInk.ratio) bestInk = { x: Math.round((xs + x - 1) / 2), ratio, bandW: bw };
    }
  }

  // Luminanz-Tal (Zweitspur): tiefster Mittelwert eines verschieblichen Fensters
  const win = Math.floor(w * 0.018);
  let bestLum = { x: -1, depth: 0 };
  for (let x = Math.floor(w * 0.42); x < Math.floor(w * 0.58); x++) {
    const v = avg(lumProf, x - win, x + win);
    const left = avg(lumProf, Math.floor(w * 0.15), x - win);
    const right = avg(lumProf, x + win, Math.floor(w * 0.85));
    const sideMin = Math.min(left, right);
    const depth = sideMin / Math.max(1, v);
    if (depth > bestLum.depth) bestLum = { x, depth };
  }

  const useInk = bestInk.ratio >= threshold;
  const useLum = !useInk && bestLum.depth >= 1.35;
  const splitX = useInk ? bestInk.x : (useLum ? bestLum.x : null);
  const evidence = `Tinte-Tal ${bestInk.ratio.toFixed(2)} (bw ${bestInk.bandW}px), Lum-Tal ${bestLum.depth.toFixed(2)} -> ${splitX !== null ? 'Split @' + splitX : 'kein Split'}`;
  return { split: splitX !== null, columnX: splitX !== null ? Math.round(splitX * scale) : null, evidence };
}

function avg(arr: Float64Array, from: number, to: number): number {
  let s = 0, n = 0;
  for (let i = Math.max(0, from); i <= Math.min(arr.length - 1, to); i++) { s += arr[i]; n++; }
  return n ? s / n : 0;
}

// --- Schatten-/Illuminations-Normalisierung ---------------------------------
// Hintergrundschätzung über hohe Perzentile in Tiles (Schatten sind dunkler als
// Papier, aber nie so dunkel wie Tinte). Weisz-Punkt wird überall einheitlich.
export function normalizeIllumination(canvas: HTMLCanvasElement, tileFrac = 0.045, whitePt = 245): HTMLCanvasElement {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const tileW = Math.max(24, Math.floor(w * tileFrac));
  const tileH = Math.max(24, Math.floor(h * tileFrac));
  const tilesX = Math.ceil(w / tileW), tilesY = Math.ceil(h / tileH);
  const bg = new Float64Array(tilesX * tilesY);
  const colCount = new Uint32Array(256);
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      colCount.fill(0);
      const x0 = tx * tileW, y0 = ty * tileH;
      const x1 = Math.min(w, x0 + tileW), y1 = Math.min(h, y0 + tileH);
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 4;
          colCount[Math.floor(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])]++;
        }
      }
      let acc = 0, target = 0;
      for (let i = y0; i < y1; i += 2) for (let j = x0; j < x1; j++) target++;
      let bgv = 250;
      for (let v = 255; v >= 0; v--) {
        acc += colCount[v];
        if (acc >= target * 0.08) { bgv = v; break; } // 92%-Perzentil
      }
      bg[ty * tilesX + tx] = Math.max(80, bgv); // nie durch Schatten ueber-hellen
    }
  }
  // bilinear gesampelte Hintergrundkarte
  const bgAt = (x: number, y: number): number => {
    const fx = Math.min(tilesX - 1.001, Math.max(0, (x / w) * tilesX - 0.5));
    const fy = Math.min(tilesY - 1.001, Math.max(0, (y / h) * tilesY - 0.5));
    const x0i = Math.floor(fx), y0i = Math.floor(fy);
    const dx = fx - x0i, dy = fy - y0i;
    const b00 = bg[y0i * tilesX + x0i];
    const b10 = bg[y0i * tilesX + Math.min(tilesX - 1, x0i + 1)];
    const b01 = bg[Math.min(tilesY - 1, y0i + 1) * tilesX + x0i];
    const b11 = bg[Math.min(tilesY - 1, y0i + 1) * tilesX + Math.min(tilesX - 1, x0i + 1)];
    return b00 * (1 - dx) * (1 - dy) + b10 * dx * (1 - dy) + b01 * (1 - dx) * dy + b11 * dx * dy;
  };
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx = out.getContext('2d')!;
  const oimg = octx.createImageData(w, h);
  const od = oimg.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const bgv = bgAt(x, y);
      const gain = bgv > 1 ? whitePt / bgv : 1;
      for (let c = 0; c < 3; c++) {
        const val = d[i + c] * gain;
        od[i + c] = val > 255 ? 255 : val;
      }
      od[i + 3] = 255;
    }
  }
  octx.putImageData(oimg, 0, 0);
  return out;
}

// --- Hilfen ------------------------------------------------------------------
export function downscale(src: HTMLCanvasElement, maxDim: number, smoothing = true): HTMLCanvasElement {
  const f = Math.min(1, maxDim / Math.max(src.width, src.height));
  if (f >= 1) {
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = smoothing;
    ctx.drawImage(src, 0, 0);
    return c;
  }
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * f); c.height = Math.round(src.height * f);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = smoothing;
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

// --- Orchestrierte Normalisierung (Stufe 1) ---------------------------------

// Stufe 1: Kontrastverbesserung. Globales Luminanz-Stretching:
// Percentile 2%..98% --> 0..255; Schatten bleiben bleich, Tinte wird dunkler.
export function boostContrast(canvas: HTMLCanvasElement, pLow = 0.02, pHigh = 0.98): HTMLCanvasElement {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const hist = new Float64Array(256);
  for (let i = 0; i < d.length; i += 4) hist[Math.floor(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])]++;
  const total = w * h;
  const percentile = (frac: number): number => {
    let acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * frac) return v; }
    return 255;
  };
  const low = percentile(pLow), high = percentile(pHigh);
  const scale = high > low ? 255 / (high - low) : 1;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx = out.getContext('2d')!;
  const oimg = octx.createImageData(w, h);
  const od = oimg.data;
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) od[i + c] = Math.min(255, Math.max(0, (d[i + c] - low) * scale));
    od[i + 3] = 255;
  }
  octx.putImageData(oimg, 0, 0);
  return out;
}


function clampNum(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function makeOdd(n: number): number {
  const i = Math.max(3, Math.round(n));
  return i % 2 === 0 ? i + 1 : i;
}

function drawBilevelCanvas(bin: Uint8Array, w: number, h: number): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0; i < bin.length; i++) {
    const v = bin[i] ? 0 : 255;
    const j = i * 4;
    d[j] = v; d[j + 1] = v; d[j + 2] = v; d[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

function bridgeHorizontalMicroGaps(bin: Uint8Array, w: number, h: number, maxGap: number): Uint8Array {
  const out = bin.slice();
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let x = 1;
    while (x < w - 1) {
      if (bin[row + x]) { x++; continue; }
      const start = x;
      while (x < w - 1 && !bin[row + x]) x++;
      const end = x; // first black or w-1
      const len = end - start;
      if (len > 0 && len <= maxGap && bin[row + start - 1] && end < w && bin[row + end]) {
        for (let xx = start; xx < end; xx++) out[row + xx] = 1;
      }
    }
  }
  return out;
}

function conservativeClean(bin: Uint8Array, w: number, h: number): Uint8Array {
  const out = bin.slice();
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      let n = 0;
      n += bin[i - w - 1]; n += bin[i - w]; n += bin[i - w + 1];
      n += bin[i - 1];                         n += bin[i + 1];
      n += bin[i + w - 1]; n += bin[i + w]; n += bin[i + w + 1];
      if (bin[i]) {
        // Nur echte Einzelpixel entfernen. Kleine musikalische Zeichen (Punkte,
        // Akzente, Fingersätze) haben fast immer mindestens zwei Nachbarn.
        if (n <= 1) out[i] = 0;
      } else {
        // Winzige weisse Löcher in Buchstaben/Notenköpfen schliessen.
        if (n >= 7) out[i] = 1;
      }
    }
  }
  return out;
}


function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clampNum((x - edge0) / Math.max(1e-6, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Graustufen-Reproduktion für Scanrestaurierung.
 *
 * Das ist absichtlich KEINE harte Binarisierung. Notenlinien aus Fotos haben
 * nach Perspektivkorrektur und Entzerrung natürliche Zwischenwerte an den
 * Kanten. Wenn wir diese Kanten auf 0/255 zwingen, entstehen Treppenstufen und
 * blockige Notenköpfe. Stattdessen wird lokal das Papierweiß entfernt und die
 * Tinte mit einer weichen S-Kurve verdichtet: Papier -> weiß, sichere Tinte ->
 * schwarz, Kanten -> graue Antialias-Pixel.
 */
export type GrayscaleProfile = {
  name: string;
  noiseFloorFrac: number;
  noiseFloorMin: number;
  noiseFloorMax: number;
  fullInkFrac: number;
  fullInkMin: number;
  fullInkMax: number;
  gamma: number;
  darkCoreLow: number;
  darkCoreHigh: number;
};

export const GRAYSCALE_PROFILES = {
  soft: {
    name: 'soft',
    noiseFloorFrac: 0.018, noiseFloorMin: 4.5, noiseFloorMax: 9.0,
    fullInkFrac: 0.24, fullInkMin: 42, fullInkMax: 72,
    gamma: 0.92, darkCoreLow: 55, darkCoreHigh: 150,
  },
  balanced: {
    name: 'balanced',
    noiseFloorFrac: 0.022, noiseFloorMin: 5.5, noiseFloorMax: 10.5,
    fullInkFrac: 0.18, fullInkMin: 34, fullInkMax: 58,
    gamma: 0.78, darkCoreLow: 70, darkCoreHigh: 170,
  },
  crisp: {
    name: 'crisp',
    noiseFloorFrac: 0.026, noiseFloorMin: 6.5, noiseFloorMax: 12.0,
    fullInkFrac: 0.145, fullInkMin: 28, fullInkMax: 48,
    gamma: 0.66, darkCoreLow: 78, darkCoreHigh: 178,
  },
  inkRich: {
    name: 'inkRich',
    noiseFloorFrac: 0.020, noiseFloorMin: 5.0, noiseFloorMax: 9.5,
    fullInkFrac: 0.15, fullInkMin: 28, fullInkMax: 50,
    gamma: 0.58, darkCoreLow: 82, darkCoreHigh: 182,
  },
} satisfies Record<string, GrayscaleProfile>;

export type GrayscaleProfileName = keyof typeof GRAYSCALE_PROFILES;

export type ScanRestoreOptions = {
  grayscaleProfile?: GrayscaleProfileName | GrayscaleProfile;
  includeComparisonStages?: boolean;
};

function resolveGrayscaleProfile(profile: GrayscaleProfileName | GrayscaleProfile | undefined): GrayscaleProfile {
  // Standard für App 2: weichere Graustufen erhalten Anti-Alias-Kanten und
  // reduzieren Speckles/Papierkorn am stärksten im automatischen Benchmark.
  if (!profile) return GRAYSCALE_PROFILES.soft;
  return typeof profile === 'string' ? GRAYSCALE_PROFILES[profile] : profile;
}

export function restoreGrayscaleDocument(canvas: HTMLCanvasElement, profileInput?: GrayscaleProfileName | GrayscaleProfile): HTMLCanvasElement {
  const profile = resolveGrayscaleProfile(profileInput);
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx = out.getContext('2d')!;
  const oimg = octx.createImageData(w, h);
  const od = oimg.data;

  const lumArr = new Uint8Array(w * h);
  const stride = w + 1;
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    const dst = (y + 1) * stride;
    const prev = y * stride;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const l = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
      lumArr[y * w + x] = l;
      row += l;
      integral[dst + x + 1] = integral[prev + x + 1] + row;
    }
  }

  // Lokales Papierweiß aus hohem Perzentil. Auf dem bereits normalisierten Bild
  // ist das stabil, korrigiert aber noch Restschatten und vergilbte Ränder.
  const bgmap = computeBgMap(canvas, 0.035);

  // Kleine Hochpass-Nachbarschaft: Druck ist kleinteilig (Notenlinien, Schrift,
  // Notenköpfe), Papierfalten/Schatten sind breitflächig. Genau diese Trennung
  // fehlte vorher und hat Falten als Tinte verstärkt.
  const detailR = Math.max(5, Math.min(28, Math.round(Math.min(w, h) * 0.0045)));
  const localMeanAt = (x: number, y: number): number => {
    const x0 = Math.max(0, x - detailR), x1 = Math.min(w - 1, x + detailR);
    const y0 = Math.max(0, y - detailR), y1 = Math.min(h - 1, y + detailR);
    const area = (x1 - x0 + 1) * (y1 - y0 + 1);
    const a = y0 * stride + x0;
    const b = y0 * stride + x1 + 1;
    const c = (y1 + 1) * stride + x0;
    const e = (y1 + 1) * stride + x1 + 1;
    return (integral[e] - integral[c] - integral[b] + integral[a]) / area;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lum = lumArr[y * w + x];
      const bg = clampNum(bgmap.at(x, y), 80, 255);

      // Papierweiß normieren, aber Tinte primär über lokale Detaildunkelheit
      // erkennen. Breite Falten können viel bg-lum haben, aber wenig DetailDrop.
      const normalized = clampNum(lum * (250 / bg), 0, 255);
      const detailMean = localMeanAt(x, y);
      const detailDrop = Math.max(0, detailMean - lum);
      const broadDrop = Math.max(0, bg - lum);

      const noiseFloor = clampNum(bg * profile.noiseFloorFrac, profile.noiseFloorMin, profile.noiseFloorMax);
      const fullInk = clampNum(bg * profile.fullInkFrac, profile.fullInkMin, profile.fullInkMax);
      const detailFullInk = clampNum(fullInk * 0.58, 16, 38);
      const detailInk = smoothstep(noiseFloor * 0.72, detailFullInk, detailDrop);

      // Antialias-Kanten liegen oft knapp unter dem Detail-Gate. Ein schwacher
      // Breitkontrast darf nur helfen, wenn auch lokaler Hochpass-Kontrast da ist.
      const broadAssist = smoothstep(noiseFloor * 1.4, fullInk * 1.1, broadDrop) *
        smoothstep(noiseFloor * 0.45, detailFullInk * 0.8, detailDrop);

      // Schatten/Falten bleiben nach Weißpunktkorrektur relativ hell.
      const printDarkGate = 1 - smoothstep(190, 240, normalized);
      let ink = Math.max(detailInk, broadAssist * 0.55) * printDarkGate;

      // Sehr dunkle Druckkerne sichern, aber nur wenn sie lokal kleinteiligen
      // Kontrast haben. Das verhindert schwarze Faltenflächen.
      const darkCore = (1 - smoothstep(profile.darkCoreLow, profile.darkCoreHigh, normalized)) *
        smoothstep(noiseFloor * 0.35, detailFullInk * 0.75, detailDrop);
      ink = Math.max(ink, darkCore * 0.98);

      // Nicht mehr auf Schwarz/Weiß kollabieren: Die Maske entscheidet nur,
      // WO Druck ist. Der Grauwert kommt weiter aus dem normalisierten Foto.
      // So bleiben schräge Linien, Notenköpfe und Schrift geglättet statt
      // blockig-pixelig zu werden.
      const alpha = Math.pow(clampNum(ink, 0, 1), profile.gamma);
      const inkTone = clampNum(((normalized - 38) / (236 - 38)) * 255, 0, 255);
      const v = Math.round(255 - alpha * (255 - inkTone));
      od[i] = v; od[i + 1] = v; od[i + 2] = v; od[i + 3] = 255;
    }
  }

  octx.putImageData(oimg, 0, 0);
  return out;
}


/**
 * Entfernt Papierkorn/Grauschleier aus der Graustufen-Restauration, ohne
 * Antialias-Kanten an echter Tinte zu verlieren. Prinzip: Graue Pixel bleiben
 * nur in der Nähe lokaler dunkler Druckkerne erhalten. Isolierte Papierstruktur
 * ohne solchen Kern wird wieder zu Weiß.
 */
export function cleanRestoredPaper(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const n = w * h;
  const core = new Uint8Array(n);

  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    // Echter Druckkern. Schwelle bewusst nicht zu tief: Notenlinien haben nach
    // der Tonwertkurve klare Kerne, Papierkorn selten zusammenhängende Kerne.
    if (l < 118) core[p] = 1;
  }

  const stride = w + 1;
  const integ = new Uint32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    const dst = (y + 1) * stride;
    const prev = y * stride;
    for (let x = 0; x < w; x++) {
      row += core[y * w + x];
      integ[dst + x + 1] = integ[prev + x + 1] + row;
    }
  }
  const radius = Math.max(3, Math.min(8, Math.round(Math.min(w, h) * 0.0016)));
  const countCore = (x: number, y: number): number => {
    const x0 = Math.max(0, x - radius), x1 = Math.min(w - 1, x + radius);
    const y0 = Math.max(0, y - radius), y1 = Math.min(h - 1, y + radius);
    return integ[(y1 + 1) * stride + x1 + 1] - integ[(y1 + 1) * stride + x0] - integ[y0 * stride + x1 + 1] + integ[y0 * stride + x0];
  };

  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx = out.getContext('2d')!;
  const oimg = octx.createImageData(w, h);
  const od = oimg.data;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const protectedInk = countCore(x, y) >= 3;
      let v = l;
      if (!protectedInk) {
        // Kein Druckkern in der Nähe: Papierkorn/Schatten progressiv bleichen.
        // Sehr dunkle, große Bereiche (z. B. Buchfalz/Tisch) bleiben als Geometrie-
        // Hinweis sichtbar; kleine graue Störungen verschwinden.
        const bleach = smoothstep(95, 230, l);
        v = l + (255 - l) * bleach;
        if (l > 135) v = 255;
      } else if (l > 205) {
        // In Nähe von Tinte: helles Papier trotzdem weiß halten, nur Kanten bleiben.
        const edge = smoothstep(205, 245, l);
        v = l + (255 - l) * edge * 0.75;
      }
      const vv = Math.round(clampNum(v, 0, 255));
      od[i] = vv; od[i + 1] = vv; od[i + 2] = vv; od[i + 3] = 255;
    }
  }
  octx.putImageData(oimg, 0, 0);
  return out;
}


/**
 * Edge-aware Antialiasing für restaurierte Graustufen.
 *
 * Die Restaurierung arbeitet hochkontrastig, damit Notenlinien klar bleiben. An
 * schrägen Linien können dadurch trotzdem Treppenkanten sichtbar werden. Dieser
 * Pass glättet nur Pixel in direkter Nähe von Tinte; stabile schwarze Kerne und
 * weißes Papier bleiben unverändert. Er ist kein allgemeiner Blur.
 */
export function antialiasInkEdges(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const lum = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) lum[p] = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);

  // Wir schreiben direkt in das gelesene ImageData zurück. Dadurch sparen wir
  // einen kompletten zusätzlichen RGBA-Puffer (~75MB bei Handyfotos).
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const c = lum[p];
      let minN = 255, maxN = 0, darkN = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const v = lum[(y + dy) * w + x + dx];
          if (v < minN) minN = v;
          if (v > maxN) maxN = v;
          if (v < 80) darkN++;
        }
      }

      const nearInk = c < 245 || minN < 130;
      const isEdge = nearInk && (maxN - minN > 35 || (c > 50 && c < 240));
      if (!isEdge) continue;
      if (c < 52 && darkN >= 4) continue; // solider Kern bleibt schwarz

      const v00 = lum[(y - 1) * w + x - 1], v01 = lum[(y - 1) * w + x], v02 = lum[(y - 1) * w + x + 1];
      const v10 = lum[y * w + x - 1],       v11 = c,                    v12 = lum[y * w + x + 1];
      const v20 = lum[(y + 1) * w + x - 1], v21 = lum[(y + 1) * w + x], v22 = lum[(y + 1) * w + x + 1];
      let v = (v00 + 2 * v01 + v02 + 2 * v10 + 4 * v11 + 2 * v12 + v20 + 2 * v21 + v22) / 16;
      // Schwarze Einzel-Treppenpixel an Kanten deutlich in Graukante überführen;
      // nicht aber Kerne von Notenköpfen/Balken.
      if (c < 95 && darkN < 4) v = Math.max(v, c + 34);
      // Weiß direkt neben Tinte nur leicht anschatten, nicht verschmutzen.
      if (c > 238 && minN < 100) v = Math.max(222, v);
      const vv = Math.round(clampNum(v, 0, 255));
      const i = p * 4;
      d[i] = vv; d[i + 1] = vv; d[i + 2] = vv; d[i + 3] = 255;
    }
  }
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  out.getContext('2d')!.putImageData(img, 0, 0);
  return out;
}

type BinarizePreset = 'strict' | 'balanced' | 'sensitive';

type BinarizeProfile = {
  sauvolaK: number;
  dropFrac: number;
  minDrop: number;
  maxDrop: number;
  bias: number;
  bridgeFactor: number;
};

const BINARIZE_PROFILES: Record<BinarizePreset, BinarizeProfile> = {
  // Sehr sauberer Druck: lieber Papier wirklich weiss lassen; gut gegen Fotoschatten/JPEG-Matsch.
  strict: { sauvolaK: 0.34, dropFrac: 0.078, minDrop: 17, maxDrop: 32, bias: -2, bridgeFactor: 0.00055 },
  // Standard für Ausgabe: konservativer als die vorige Version, aber dünne Linien bleiben erhalten.
  balanced: { sauvolaK: 0.26, dropFrac: 0.060, minDrop: 12, maxDrop: 24, bias: 2, bridgeFactor: 0.00065 },
  // Diagnose/Notfall bei sehr blasser Tinte: mehr retten, kann Papierkorn eher mitnehmen.
  sensitive: { sauvolaK: 0.18, dropFrac: 0.046, minDrop: 9, maxDrop: 19, bias: 6, bridgeFactor: 0.00075 },
};

/**
 * Finale Schwarz-Weiss-Separation für Musikscans.
 *
 * Ausgabe ist echtes bilevel: jeder Pixel ist entweder Tinte oder Papier.
 * Die vorige Version war zu permissiv: ein separates "Faint-ink"-ODER konnte
 * Schatten/Papierstruktur als Tinte retten. Jetzt entscheidet ein EINZIGER
 * lokaler Schwellwert: Sauvola (lokale Statistik) wird durch die lokale
 * Papierweiss-Schätzung gedeckelt. Damit kann Hintergrund nie bloss wegen
 * Beleuchtungsabfall schwarz werden, aber echte dunkle Notentinte bleibt scharf.
 */
export function binarizeMusicDocument(canvas: HTMLCanvasElement, preset: BinarizePreset = 'balanced'): HTMLCanvasElement {
  const profile = BINARIZE_PROFILES[preset];
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const n = w * h;
  const lum = new Uint8Array(n);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    lum[p] = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
  }

  // Fenster proportional: bei 300dpi-A4 typ. 85-125px. Das sieht lokal genug
  // für Schatten aus, aber weit genug, um Buchstaben/Notenköpfe nicht als
  // Hintergrund zu interpretieren.
  const win = makeOdd(clampNum(Math.min(w, h) * 0.035, 51, 181));
  const r = Math.floor(win / 2);
  const stride = w + 1;
  const integral = new Float64Array((w + 1) * (h + 1));
  const integralSq = new Float64Array((w + 1) * (h + 1));

  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    let rowSq = 0;
    const srcRow = y * w;
    const dstRow = (y + 1) * stride;
    const prevRow = y * stride;
    for (let x = 0; x < w; x++) {
      const v = lum[srcRow + x];
      rowSum += v;
      rowSq += v * v;
      integral[dstRow + x + 1] = integral[prevRow + x + 1] + rowSum;
      integralSq[dstRow + x + 1] = integralSq[prevRow + x + 1] + rowSq;
    }
  }

  const bgmap = computeBgMap(canvas, 0.035);
  const bin = new Uint8Array(n);
  const sauvolaR = 128;

  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h - 1, y + r);
    const iy0 = y0 * stride;
    const iy1 = (y1 + 1) * stride;
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w - 1, x + r);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum = integral[iy1 + x1 + 1] - integral[iy1 + x0] - integral[iy0 + x1 + 1] + integral[iy0 + x0];
      const sumSq = integralSq[iy1 + x1 + 1] - integralSq[iy1 + x0] - integralSq[iy0 + x1 + 1] + integralSq[iy0 + x0];
      const mean = sum / area;
      const variance = Math.max(0, sumSq / area - mean * mean);
      const std = Math.sqrt(variance);
      const sauvola = mean * (1 + profile.sauvolaK * (std / sauvolaR - 1));

      const idx = y * w + x;
      const l = lum[idx];
      const bg = bgmap.at(x, y);
      const requiredDrop = clampNum(bg * profile.dropFrac, profile.minDrop, profile.maxDrop);
      // Der lokale Sauvola-Wert darf nie über "Papierweiss minus Mindestabstand"
      // steigen. Genau das verhindert den unbrauchbaren Grauschleier->Tinte-Fall.
      const threshold = clampNum(Math.min(sauvola + profile.bias, bg - requiredDrop), 0, 245);
      bin[idx] = l <= threshold ? 1 : 0;
    }
  }

  const bridged = bridgeHorizontalMicroGaps(bin, w, h, Math.max(1, Math.round(Math.min(w, h) * profile.bridgeFactor)));
  const cleaned = conservativeClean(bridged, w, h);
  return drawBilevelCanvas(cleaned, w, h);
}

export async function restoreScanImage(srcCanvas: HTMLCanvasElement, options: ScanRestoreOptions = {}): Promise<RestoredPage[]> {
  const debug: ScanDebug = {
    orientationVotes: '', fineAngleDeg: 0, split: 'einseitig', splitColumnX: null, splitEvidence: '', stageImages: []
  };
  const grayscaleProfile = resolveGrayscaleProfile(options.grayscaleProfile);
  const includeComparisonStages = options.includeComparisonStages ?? true;

  debug.stageImages.push({ label: 'Original', dataUrl: downscale(srcCanvas, 700).toDataURL('image/jpeg', 0.75) });

  // 1. Groborientierung (inkl. 90°!)
  const o = estimateOrientation90(srcCanvas);
  debug.orientationVotes = o.votes;
  // Stufe 1: Kontrastverbesserung (globales Luminanz-Stretching) + Stufe 2:
  // Vereinheitlichung (Schatten entfernen) - erst Helligkeit und Einheitlichkeit
  // sicherstellen, dann MESSEN und KORRIGIEREN, in dieser Reihenfolge.
  let work = boostContrast(srcCanvas);
  debug.stageImages.push({ label: 'Kontrastverbesserung', dataUrl: downscale(work, 700).toDataURL('image/jpeg', 0.75) });
  work = normalizeIllumination(work);
  debug.stageImages.push({ label: 'Vereinheitlichung', dataUrl: downscale(work, 700).toDataURL('image/jpeg', 0.75) });

  if (o.rotate90) {
    const r = document.createElement('canvas');
    r.width = work.height; r.height = work.width;
    const rctx = r.getContext('2d')!;
    rctx.fillStyle = 'white';
    rctx.fillRect(0, 0, r.width, r.height);
    rctx.translate(r.width / 2, r.height / 2);
    rctx.rotate(Math.PI / 2);
    rctx.drawImage(work, -work.width / 2, -work.height / 2);
    work = r;
  }

  // 2. Feinwinkel
  const fa = estimateFineAngle(work);
  debug.fineAngleDeg = fa.angleDeg;
  if (fa.angleDeg !== 0) work = rotateCanvas(work, fa.angleDeg);
  debug.stageImages.push({ label: `Ausgerichtet (${o.rotate90 ? '90°+' : ''}${fa.angleDeg.toFixed(2)}°)`, dataUrl: downscale(work, 700).toDataURL('image/jpeg', 0.75) });

  // 3. Geometrie: Prediktiv-Spur-Gitter (Innen nach aussen) zuerst; Kontur-Fallback.
  let trackGrid = estimateTrackGrid(work);
  if (trackGrid.staves.length < 4 || trackGrid.coverage < 0.4) {
    const polyGrid = estimatePolynomialStaffGrid(work);
    if (polyGrid.staves.length > trackGrid.staves.length || polyGrid.coverage > trackGrid.coverage) {
      debug.splitEvidence += `[Pixel-Tracker ersetzt durch Polynom-Linien: ${trackGrid.reason || `${trackGrid.staves.length} Staffeln`} -> ${polyGrid.staves.length} Staffeln] `;
      trackGrid = polyGrid;
    }
  }
  // Spur-Entwölbung nur verwenden, wenn wirklich ein nennenswertes Seiten-Gitter
  // erkannt wurde. 1-2 zufällig getrackte Staffeln würden sonst die ganze Seite
  // auf wenige Notenzeilen zusammendrücken (bei Handyfotos katastrophal).
  if (trackGrid.coverage >= 0.4 && trackGrid.staves.length >= 4) {
    debug.stageImages.push({ label: `Spur-Gitter (${trackGrid.staves.length} Staffeln, Spatium ${trackGrid.spatiumPx.toFixed(1)}px, Abdeckung ${(trackGrid.coverage * 100).toFixed(0)}%)`, dataUrl: trackGrid.overlay ? trackGrid.overlay.toDataURL('image/jpeg', 0.75) : '' });
    const straight = straightenStaffBands(work, trackGrid);
    work = straight.canvas;
    debug.splitEvidence += `[${straight.evidence}] `;
    debug.stageImages.push({ label: 'Entwölbt lokal (layout-erhaltend)', dataUrl: downscale(work, 700).toDataURL('image/jpeg', 0.75) });
  } else {
    debug.splitEvidence += `[kein Spur-Gitter: ${trackGrid.reason || 'unbekannt'}] `;

    // Perspektive nur über die grobe Papierkontur: Die eigentliche Buchfoto-
    // Bereinigung (linke Nebenseite/Falz/Tisch) passiert später als Maske. Eine
    // aggressive Hauptseiten-Homographie kann bei sichtbarer Doppelseite Musik
    // am rechten Rand abschneiden.
    const pc = detectPageCorners(work);
    const contourSource: 'Kontur' = 'Kontur';

    if (pc.corners) {
      // Rahmen-Kopie erkennen: Alle Ecken nahe am Bildrand -> Homographie ~Identitaet.
      const smallW = downscale(work, 900);
      const near = (p: [number, number]) => Math.min(p[0], p[1], smallW.width - p[0], smallW.height - p[1]) < smallW.width * 0.04;
      const allNear = pc.corners.every(near);
      if (allNear && contourSource === 'Kontur') debug.splitEvidence += '[Kontur=Rahmen, homographie identisch] ';
      // Ausgabeformat: Seitenverhaeltnis aus Ecken-Geometrie schätzen, sonst A4-Quer/Port je Lage
      const estW = Math.max( Math.hypot(pc.corners[1][0]-pc.corners[0][0], pc.corners[1][1]-pc.corners[0][1]), Math.hypot(pc.corners[2][0]-pc.corners[3][0], pc.corners[2][1]-pc.corners[3][1]) );
      const estH = Math.max( Math.hypot(pc.corners[3][0]-pc.corners[0][0], pc.corners[3][1]-pc.corners[0][1]), Math.hypot(pc.corners[2][0]-pc.corners[1][0], pc.corners[2][1]-pc.corners[1][1]) );
      // Nicht künstlich auf ~2400px herunterrechnen: Bei restaurierter Ausgabe
      // sieht man sonst Treppenstufen sofort. Wir bleiben nah an der realen
      // Fotoauflösung und geben deutliches Supersampling dazu; die finale
      // Tonwert-/Graustufenrekonstruktion passiert erst danach.
      const scaleProbe = downscale(work, 900);
      const sourceScale = work.width / scaleProbe.width;
      const restoreScale = sourceScale * 1.25;
      scaleProbe.width = 0; scaleProbe.height = 0;
      const tgtW = Math.min(4800, Math.max(1200, Math.round(estW * restoreScale)));
      const tgtH = Math.min(6800, Math.max(1600, Math.round(estH * restoreScale)));
      work = rectifyPerspective(work, pc.corners, tgtW, tgtH);
      debug.stageImages.push({ label: `Perspektive entzerrt (${contourSource})`, dataUrl: downscale(work, 700).toDataURL('image/jpeg', 0.75) });
      debug.splitEvidence += `${contourSource} OK (${pc.evidence}). `;
    } else {
      debug.splitEvidence += `Kontur nicht sicher (${pc.evidence}). `;
    }
  }

  // Nach Perspektivkorrektur erst eine robuste, layout-erhaltende Spalten-
  // Entwölbung versuchen. Sie braucht kein vollständiges Staff-Gitter und hilft
  // gegen Buchwölbung/Treppeneffekte.
  const beforeColStraight = work;
  const colStraight = straightenByColumnProjection(work);
  work = colStraight.canvas;
  debug.splitEvidence += `[${colStraight.evidence}] `;
  if (colStraight.canvas !== beforeColStraight) debug.stageImages.push({ label: 'Entwölbt per Spaltenprojektion', dataUrl: downscale(work, 700).toDataURL('image/jpeg', 0.75) });

  // Danach erneut Staff-Linien suchen: hier sind die Linien wesentlich stabiler
  // als im rohen Handyfoto. Nur wenn genug Staffeln gefunden wurden, lokal und
  // layout-erhaltend entwölben.
  let postGrid = estimateTrackGrid(work);
  if (postGrid.staves.length < 4 || postGrid.coverage < 0.35) {
    const polyPost = estimatePolynomialStaffGrid(work);
    if (polyPost.staves.length > postGrid.staves.length || polyPost.coverage > postGrid.coverage) {
      debug.splitEvidence += `[Post-Polynom-Linien: ${postGrid.reason || `${postGrid.staves.length} Staffeln`} -> ${polyPost.staves.length} Staffeln] `;
      postGrid = polyPost;
    }
  }
  if (postGrid.coverage >= 0.35 && postGrid.staves.length >= 4) {
    debug.stageImages.push({ label: `Post-Gitter (${postGrid.staves.length} Staffeln, Spatium ${postGrid.spatiumPx.toFixed(1)}px)`, dataUrl: postGrid.overlay ? postGrid.overlay.toDataURL('image/jpeg', 0.75) : '' });
    const straight = straightenStaffBands(work, postGrid);
    work = straight.canvas;
    debug.splitEvidence += `[post ${straight.evidence}] `;
    debug.stageImages.push({ label: 'Entwölbt lokal nach Perspektive', dataUrl: downscale(work, 700).toDataURL('image/jpeg', 0.75) });
  } else {
    debug.splitEvidence += `[kein Post-Gitter: ${postGrid.reason || `${postGrid.staves.length} Staffeln, Abdeckung ${(postGrid.coverage * 100).toFixed(0)}%`}] `;
  }

  // 4. Doppelseiten-Erkennung auf dem entzerrten Bild
  const dp = detectDoublePage(work);
  debug.splitEvidence += dp.evidence;
  const halves: HTMLCanvasElement[] = [];
  if (dp.split && dp.columnX !== null) {
    debug.split = 'doppelseitig';
    debug.splitColumnX = dp.columnX;
    for (const [x0, w] of [[0, dp.columnX], [dp.columnX, work.width - dp.columnX]] as const) {
      const h2 = document.createElement('canvas');
      h2.width = w; h2.height = work.height;
      h2.getContext('2d')!.drawImage(work, x0, 0, w, work.height, 0, 0, w, work.height);
      halves.push(h2);
    }
  } else {
    halves.push(work);
  }

  // 5. Illuminations-Normalisierung je Halbseite + finale lokale
  // Graustufen-Reproduktion. Keine harte Binarisierung als Ausgabe: Die
  // Anti-Alias-Kanten bleiben erhalten, dadurch verschwinden die blockigen
  // Treppenstufen an Notenlinien und Schrift.
  const results: RestoredPage[] = [];
  halves.forEach((hc, idx) => {
    const norm = normalizeIllumination(hc);
    if (idx === 0) debug.stageImages.push({ label: 'Schatten entfernt', dataUrl: downscale(norm, 700).toDataURL('image/jpeg', 0.75) });

    // Diagnose: harte SW-Kandidaten bleiben nur als Vergleich sichtbar. Die
    // Ausgabe selbst ist Graustufe, weil harte 0/255-Kanten bei Fotos pixelig
    // wirken und musikalische Rundungen zerstören.
    if (idx === 0 && includeComparisonStages) {
      const prev = downscale(norm, 1200);
      for (const profileName of Object.keys(GRAYSCALE_PROFILES) as GrayscaleProfileName[]) {
        const grayPrev = antialiasInkEdges(cleanRestoredPaper(restoreGrayscaleDocument(prev, profileName)));
        debug.stageImages.push({ label: `Graustufen-Kandidat ${profileName}`, dataUrl: grayPrev.toDataURL('image/png') });
      }
      for (const preset of ['strict', 'balanced', 'sensitive'] as const) {
        const cand = binarizeMusicDocument(prev, preset);
        debug.stageImages.push({ label: `SW-Vergleich ${preset}`, dataUrl: cand.toDataURL('image/png') });
      }
    }

    const gray = antialiasInkEdges(cleanRestoredPaper(restoreGrayscaleDocument(norm, grayscaleProfile)));
    if (idx === 0) debug.stageImages.push({ label: `Graustufen AUSGABE (${grayscaleProfile.name}, anti-aliased + papierbereinigt)`, dataUrl: downscale(gray, 700, true).toDataURL('image/png') });
    results.push({ canvas: gray, debug });
  });
  return results;
}


// ============================================================================
// ========== STUFE 2: PREDIKTIVER SPUR-TRACKER + GITTER-ENTZERRUNG ============
// (Innen nach aussen; folgt dem uebernommenen Erkennungsrezept)
// ============================================================================

// --- Adaptive Binarisierung (foto-tauglich) ---------------------------------
export type BgMap = { tilesX: number; tilesY: number; bg: Float64Array; tileW: number; tileH: number; at: (x: number, y: number) => number };

export function computeBgMap(canvas: HTMLCanvasElement, tileFrac = 0.05): BgMap {
  const w = canvas.width, h = canvas.height;
  const d = canvas.getContext('2d')!.getImageData(0, 0, w, h).data;
  const tileW = Math.max(20, Math.floor(w * tileFrac));
  const tileH = Math.max(20, Math.floor(h * tileFrac));
  const tilesX = Math.ceil(w / tileW), tilesY = Math.ceil(h / tileH);
  const bg = new Float64Array(tilesX * tilesY);
  const cnt = new Uint32Array(256);
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      cnt.fill(0);
      let tot = 0, acc = 0, bgv = 245;
      for (let y = ty * tileH; y < Math.min(h, (ty + 1) * tileH); y += 2) {
        for (let x = tx * tileW; x < Math.min(w, (tx + 1) * tileW); x++) {
          const i = (y * w + x) * 4;
          cnt[Math.floor(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])]++;
          tot++;
        }
      }
      for (let v = 255; v >= 0; v--) { acc += cnt[v]; if (acc >= tot * 0.10) { bgv = v; break; } }
      bg[ty * tilesX + tx] = Math.max(60, bgv);
    }
  }
  return { tilesX, tilesY, bg, tileW, tileH, at: (x: number, y: number) => {
    const fx = Math.min(tilesX - 1.001, Math.max(0, (x / w) * tilesX - 0.5));
    const fy = Math.min(tilesY - 1.001, Math.max(0, (y / h) * tilesY - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), dx = fx - x0, dy = fy - y0;
    const b00 = bg[y0 * tilesX + x0], b10 = bg[y0 * tilesX + Math.min(tilesX - 1, x0 + 1)], b01 = bg[Math.min(tilesY - 1, y0 + 1) * tilesX + x0], b11 = bg[Math.min(tilesY - 1, y0 + 1) * tilesX + Math.min(tilesX - 1, x0 + 1)];
    return b00 * (1 - dx) * (1 - dy) + b10 * dx * (1 - dy) + b01 * (1 - dx) * dy + b11 * dx * dy;
  } };
}

export function binarizeAdaptive(canvas: HTMLCanvasElement, tileFrac = 0.05, darkFactor = 0.62): Uint8Array {
  const w = canvas.width, h = canvas.height;
  const d = canvas.getContext('2d')!.getImageData(0, 0, w, h).data;
  const bgmap = computeBgMap(canvas, tileFrac);
  const bgAt = bgmap.at;
  const bin = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const bgv = bgAt(x, y);
      if (l < bgv * darkFactor && l < bgv - 18) bin[y * w + x] = 1;
    }
  }
  return bin;
}

// --- Horizontales Close (heilt 1px-Linien Lochstellen) ----------------------
export function closeH(bin: Uint8Array, w: number, h: number, k: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const off = y * w;
    for (let x = 0; x < w; x++) {
      if (bin[off + x] === 1) { out[off + x] = 1; continue; }
      let nb = -1;
      for (let j = x + 1; j <= Math.min(w - 1, x + k); j++) { if (bin[off + j] === 1) { nb = j; break; } }
      let pb = -1;
      for (let j = x - 1; j >= Math.max(0, x - k); j--) { if (bin[off + j] === 1) { pb = j; break; } }
      if (nb >= 0 && pb >= 0 && nb - pb <= k) out[off + x] = 1;
    }
  }
  return out;
}

// --- Tracker-Helfer ----------------------------------------------------------
type TrackPt = { x: number; y: number };
export type Trajectory = {
  pts: TrackPt[];
  startX: number; endX: number;
  fitDeg: number;
  residRms: number;
  evalAt: (x: number) => number;
  evalAtSafe: (x: number) => number; // ausserhalb: linear aus Messwerten, nicht Polynom
};

// Lokale Rand-Steigung aus lokalen Messpunkten (kein Polynomableitung - die
// oszilliert am Rand am staerksten).
function edgeSlope(pts: TrackPt[], which: 'start' | 'end'): number {
  const n = Math.min(12, pts.length);
  if (pts.length < 3) return 0;
  const pick = which === 'start' ? pts.slice(0, n) : pts.slice(-n);
  const dx = pick[pick.length - 1].x - pick[0].x;
  if (Math.abs(dx) < 1e-6) return 0;
  return (pick[pick.length - 1].y - pick[0].y) / dx;
}

// Chebyshev-Fit in normalisierter x-Basis; Grad nach vermessener Strecke.
function chebFit(pts: TrackPt[]): { deg: number; evalAt: (x: number) => number } {
  const n = pts.length;
  if (n === 0) return { deg: 0, evalAt: () => 0 };
  if (n === 1) return { deg: 0, evalAt: () => pts[0].y };
  const x0p = pts[0].x, x1p = pts[pts.length - 1].x;
  const span = x1p - x0p;
  let deg: number;
  if (span < 80) deg = 1; else if (span < 180) deg = 2; else if (span < 420) deg = 3; else if (span < 820) deg = 4; else deg = 5;
  if (deg > n - 1) deg = Math.max(1, n - 1);
  const u = (x: number) => (span === 0 ? 0 : (2 * (x - x0p) / span) - 1);
  const T: number[][] = [];
  for (let k = 0; k <= deg; k++) T.push(pts.map(p => Math.cos(k * Math.acos(Math.max(-1, Math.min(1, u(p.x)))))));
  const A: number[][] = Array.from({ length: deg + 1 }, () => new Array(deg + 1).fill(0));
  const b: number[] = new Array(deg + 1).fill(0);
  for (let i = 0; i <= deg; i++) {
    for (let j = 0; j <= deg; j++) { let sm = 0; for (let m = 0; m < n; m++) sm += T[i][m] * T[j][m]; A[i][j] = sm; }
    let sm = 0; for (let m = 0; m < n; m++) sm += T[i][m] * pts[m].y;
    b[i] = sm;
  }
  for (let i = 0; i <= deg; i++) A[i][i] += 1e-6;
  for (let col = 0; col <= deg; col++) {
    let piv = col, mx = Math.abs(A[col][col]);
    for (let r = col + 1; r <= deg; r++) { const v = Math.abs(A[r][col]); if (v > mx) { mx = v; piv = r; } }
    if (piv !== col) { const t1 = A[col]; A[col] = A[piv]; A[piv] = t1; const t2 = b[col]; b[col] = b[piv]; b[piv] = t2; }
    const diag = A[col][col];
    if (Math.abs(diag) < 1e-12) return { deg: 1, evalAt: () => 0 };
    for (let r = col + 1; r <= deg; r++) {
      const f = A[r][col] / diag;
      for (let cc = col; cc <= deg; cc++) A[r][cc] -= f * A[col][cc];
      b[r] -= f * b[col];
    }
  }
  const coef = new Array(deg + 1).fill(0);
  for (let i = deg; i >= 0; i--) {
    let sm = b[i];
    for (let j = i + 1; j <= deg; j++) sm -= A[i][j] * coef[j];
    coef[i] = sm / A[i][i];
  }
  const evalAt = (x: number) => {
    const uu = Math.max(-1, Math.min(1, u(x)));
    let res = 0;
    for (let k = 0; k <= deg; k++) res += coef[k] * Math.cos(k * Math.acos(uu));
    return res;
  };
  return { deg, evalAt };
}

// Dicke trennt: Suche duenne schwarze Saeule um Vorhersage y; nichts Gefundenes = verdeckt.
export function measureThin(d: Uint8ClampedArray, w: number, h: number, x: number, y: number, searchHalf: number, maxThick: number, bgAt?: (x: number, y: number) => number): number | null {
  const lumAt = (yy: number): number => {
    const i = (yy * w + x) * 4;
    return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  };
  const thrOf = (yy: number): number => {
    if (!bgAt) return 125;
    const v = lumAt(yy);
    const bgv = bgAt(x, yy);
    const t = Math.min(bgv * 0.62, bgv - 18);
    return t;
  };
  const thr = 125;
  let bestCenter: number | null = null;
  let bestScore = -1;
  for (let yg = Math.max(1, Math.floor(y - searchHalf)); yg < Math.min(h - 1, y + searchHalf); yg++) {
    if (lumAt(yg) > thrOf(yg)) continue;
    let y0 = yg, y1 = yg;
    while (y0 > 0 && lumAt(y0 - 1) <= thrOf(y0)) y0--;
    while (y1 < h - 1 && lumAt(y1 + 1) <= thrOf(y1)) y1++;
    const thick = y1 - y0 + 1;
    if (thick <= maxThick) {
      let cntBlack = 0;
      for (let yy = y0; yy <= y1; yy++) if (lumAt(yy) < thrOf(yy)) cntBlack++;
      if (cntBlack >= 1) {
        const score = cntBlack / (thick * 1.0);
        if (score > bestScore) { bestScore = score; bestCenter = (y0 + y1) / 2; }
      }
    }
  }
  return bestCenter;
}

// Tracker in einer Richtung ab (seedX, seedY); Vorhersage aus ALLEN Messpunkten (Refit periodisch)
export function trackOne(d: Uint8ClampedArray, w: number, h: number, seedX: number, seedY: number, searchHalf: number, bgAt?: (x: number, y: number) => number): Trajectory | null {
  const left = walkLine(d, w, h, seedX - 1, seedY, -1, searchHalf, bgAt);
  const right = walkLine(d, w, h, seedX, seedY, 1, searchHalf, bgAt);
  const all = [...left, { x: seedX, y: seedY }, ...right];
  if (all.length < 15) return null;
  const fit = chebFit(all);
  let sq = 0;
  for (const p of all) sq += (p.y - fit.evalAt(p.x)) ** 2;
  const residRms = Math.sqrt(sq / all.length);
  const evalAtSafe = (x: number) => {
    if (x < all[0].x) {
      // links ausser Messinterval: Randsteigung aus den ersten 12 Messpunkten
      const slope = edgeSlope(all, 'start');
      return all[0].y + (x - all[0].x) * slope;
    }
    if (x > all[all.length - 1].x) {
      const slope = edgeSlope(all, 'end');
      return all[all.length - 1].y + (x - all[all.length - 1].x) * slope;
    }
    return fit.evalAt(x);
  };
  return { pts: all, startX: all[0].x, endX: all[all.length - 1].x, fitDeg: fit.deg, residRms, evalAt: fit.evalAt, evalAtSafe };
}
function walkLine(d: Uint8ClampedArray, w: number, h: number, seedX: number, seedY: number, dir: 1 | -1, searchHalf: number, bgAt?: (x: number, y: number) => number): TrackPt[] {
  const pts: TrackPt[] = [];
  let fit: { deg: number; evalAt: (x: number) => number } | null = null;
  let voidStreak = 0;
  const maxVoid = Math.max(4, Math.round(searchHalf * 0.8));
  for (let x = seedX; x >= 0 && x < w; x += dir) {
    if (fit === null && pts.length >= 6) fit = chebFit(pts);
    else if (fit !== null && pts.length % 12 === 0) fit = chebFit(pts);
    const pred = fit !== null ? fit.evalAt(x) : seedY;
    const m = measureThin(d, w, h, x, pred, searchHalf, Math.max(2, Math.floor(searchHalf * 0.45)), bgAt);
    if (m !== null) {
      if (pts.length >= 10 && Math.abs(m - pred) > searchHalf * 0.65) { voidStreak++; if (voidStreak > maxVoid) break; continue; }
      pts.push({ x, y: m });
      voidStreak = 0;
    } else {
      voidStreak++;
      if (voidStreak > maxVoid) break;
    }
  }
  return dir === 1 ? pts : pts.reverse();
}

// Saat-Mittelpunkte duenner schwarzer Laufe pro Spalte (kein Messen dunkler Blobs = Note)
export function thinSeeds(bin: Uint8Array, w: number, h: number, maxThick: number, colStep: number): { x: number; y: number }[] {
  const seeds: { x: number; y: number }[] = [];
  for (let x = 0; x < w; x += colStep) {
    let runStart = -1;
    for (let y = 0; y < h; y++) {
      if (bin[y * w + x] === 1) { if (runStart < 0) runStart = y; }
      else if (runStart >= 0) {
        const thick = y - runStart;
        if (thick >= 1 && thick <= maxThick) seeds.push({ x, y: Math.floor((runStart + y - 1) / 2) });
        runStart = -1;
      }
    }
  }
  return seeds;
}

// Spatium aus Seed-Abstaenden (Massendominanz der Staffelabstaende)
export function estimateSpatium(seeds: { x: number; y: number }[], h: number): number {
  const byCol = new Map<number, number[]>();
  for (const sd of seeds) {
    if (!byCol.has(sd.x)) byCol.set(sd.x, []);
    byCol.get(sd.x)!.push(sd.y);
  }
  const gaps: number[] = [];
  for (const ys of byCol.values()) {
    ys.sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) {
      const d = ys[i] - ys[i - 1];
      if (d >= Math.max(5, h * 0.004) && d <= h * 0.05) gaps.push(d);
    }
  }
  if (gaps.length < 4) return 0;
  const binW = 2;
  const histo = new Map<number, { count: number; sum: number }>();
  for (const d of gaps) {
    const b2 = Math.floor(d / binW) * binW;
    const cur = histo.get(b2) ?? { count: 0, sum: 0 };
    histo.set(b2, { count: cur.count + 1, sum: cur.sum + d });
  }
  let best = -1, bestC = 0;
  for (const [b2, v] of histo) if (v.count > bestC) { bestC = v.count; best = v.sum / v.count; }
  return best;
}

// Entzerrung nach Gitter (Prediktive Tracks -> Zeilen -> Raster-Rücktransformation)
export type GridResult = {
  staves: { rows: Trajectory[] }[];
  spatiumPx: number;
  coverage: number;
  reason?: string;
  overlay: HTMLCanvasElement | null;
};

export function estimateTrackGrid(canvas: HTMLCanvasElement): GridResult {
  const small = downscale(canvas, 1300);
  const w = small.width, h = small.height;
  const d = small.getContext('2d')!.getImageData(0, 0, w, h).data;
  const bgmap = computeBgMap(small);
  const bgAt = bgmap.at;
  const bin = closeH(binarizeAdaptive(small), w, h, 4);
  // 1) Saat-Maße
  const seedStep = Math.max(15, Math.floor(w * 0.03));
  const maxThickSeed = Math.max(2, Math.floor(h * 0.003));
  const seeds = thinSeeds(bin, w, h, maxThickSeed, seedStep);
  const spatiumPx = estimateSpatium(seeds, h);
  if (spatiumPx < 5 || spatiumPx > h * 0.05) {
    return { staves: [], spatiumPx, coverage: 0, reason: `kein Spatium aus Seeds (sp=${spatiumPx.toFixed(1)}, seeds=${seeds.length})`, overlay: null };
  }
  // 2) pro Seed traekern; starke Tracks nur (Residuen-Qualitaet greift)
  const searchHalf = Math.max(4, Math.floor(spatiumPx * 0.7));
  const trackList: Trajectory[] = [];
  const goodTracks: Trajectory[] = [];
  for (const sd of seeds) {
    const tr = trackOne(d, w, h, sd.x, sd.y, searchHalf, bgAt);
    if (tr) {
      trackList.push(tr);
      const span = tr.endX - tr.startX;
      if (span >= w * 0.10 && tr.residRms <= Math.max(2.5, spatiumPx * 0.9)) goodTracks.push(tr);
    }
  }
  if (goodTracks.length < 8) {
    return { staves: [], spatiumPx, coverage: 0, reason: `nur ${goodTracks.length} starke Spuren (${trackList.length} gesamt, sp=${spatiumPx.toFixed(1)})`, overlay: null };
  }
  // 3) Zeilencluster: sortiere Trajektorien nach evalAt(Mitte), clusteriere sie bei ~spatium-Zusammenhang
  const cx = w / 2;
  const keyed = goodTracks.map((t, i) => ({ midEval: t.evalAt(cx), t })).sort((a, b) => a.midEval - b.midEval);
  const rows: Trajectory[][] = [];
  for (const { t } of keyed) {
    const mids = (r: Trajectory[]) => r.reduce((acc, q) => acc + q.evalAt(cx), 0) / r.length;
    const last = rows[rows.length - 1];
    if (last && Math.abs((t.evalAt(cx) - mids(last))) < spatiumPx * 0.55) last.push(t);
    else rows.push([t]);
  }
  // Gruppierung in Staffeln (5 Zeilen)
  // Pro Zeile die staerkste Trajektorie (geringstes Residuum) als Bestandteil waehlen
  const rowsBest: Trajectory[] = rows.map(r => r.reduce((best, cur) => (cur.residRms < best.residRms ? cur : best)));
  const rowsMidY = rowsBest.map(r => r.evalAt(cx));
  const staves: { rows: Trajectory[] }[] = [];
  // Sequenzbildung: Gap-Ratio-Konsistenz (ortsunabhaengig von der globalen
  // Spatium-Schaetzung; Perspektive ertraegt nur Konsistenz, nicht Grosze).
  const usedRow = new Set<number>();
  const maxX0 = (t: Trajectory) => t.startX;
  const maxX1 = (t: Trajectory) => t.endX;
  const overlapWidth = (tra: Trajectory, trb: Trajectory) => Math.max(0, Math.min(maxX1(tra), maxX1(trb)) - Math.max(maxX0(tra), maxX0(trb)));
  for (let i2 = 0; i2 <= rowsBest.length - 5; i2++) {
    if (usedRow.has(i2)) continue;
    const seq: number[] = [i2];
    const gapsNew: number[] = [];
    let lastY = rowsMidY[i2];
    for (let j = i2 + 1; j < rowsBest.length && seq.length < 5; j++) {
      const d2 = rowsMidY[j] - lastY;
      if (d2 < spatiumPx * 0.3) continue; // Duplikat/geteilte Zeile ignorieren
      if (gapsNew.length > 0) {
        const ratio = d2 / gapsNew[gapsNew.length - 1];
        if (ratio < 0.66 || ratio > 1.5) break;
      }
      seq.push(j);
      gapsNew.push(d2);
      lastY = rowsMidY[j];
    }
    if (seq.length === 5) {
      // Fragmente muessen sich nicht ueberschneiden: Entscheidend ist die
      // vereinigte x-Deckung (Union der x-Intervalle >= 25% der Breite).
      const five = seq.map(g => rowsBest[g]);
      const intervals = five.map(t => [t.startX, t.endX] as [number, number]).sort((a, b) => a[0] - b[0]);
      let cover = 0; let cur0 = -1e9, cur1 = -1e9;
      for (const [a2, b2] of intervals) {
        if (a2 > cur1) { cover += cur1 - cur0; cur0 = a2; cur1 = b2; } else if (b2 > cur1) cur1 = b2;
      }
      cover += cur1 - cur0;
      // Zentaum der Fuenf-Trajektorien: Fragmente derselben Notenlinie haften
      // im Mittel die gleiche x-Position. Mischen wir Spuren von Nachbarsystemen,
      // variiert ihr Zentrum ueber den halben Bereich streuend.
      const centers = five.map(t => (t.startX + t.endX) / 2);
      const cMin = Math.min(...centers), cMax = Math.max(...centers);
      const cSpreadOK = (cMax - cMin) <= w * 0.4;
      if (cover >= w * 0.25 && cSpreadOK) {
        seq.forEach(g => usedRow.add(g));
        staves.push({ rows: five });
        i2 = seq[seq.length - 1];
      }
    }
  }
  if (staves.length === 0) {
    return { staves: [], spatiumPx, coverage: 0, reason: `keine 5er-Staffel aus ${goodTracks.length} Spuren (sp=${spatiumPx.toFixed(1)}, rows=${rows.length})`, overlay: null };
  }
  // Abdeckung: gemessene Breite im gemittelten Raster
  const minX = Math.min(...staves.flatMap(st => st.rows.flat().map(t => t.startX)));
  const maxX = Math.max(...staves.flatMap(st => st.rows.flat().map(t => t.endX)));
  const coverage = (maxX - minX) / w;
  // Overlay
  const overlay = document.createElement('canvas');
  overlay.width = w; overlay.height = h;
  const octx = overlay.getContext('2d')!;
  octx.drawImage(small, 0, 0);
  octx.strokeStyle = 'red';
  octx.lineWidth = 2;
  for (const st of staves) for (const t of st.rows) {
    octx.beginPath();
    octx.moveTo(t.startX, t.evalAt(t.startX));
    for (let x = t.startX; x <= t.endX; x += 8) octx.lineTo(x, t.evalAt(x));
    octx.stroke();
  }
  return { staves, spatiumPx, coverage, overlay };
}


function trajectoryFromPolynomialPts(ptsIn: TrackPt[], w: number): Trajectory | null {
  const pts = ptsIn.slice().sort((a, b) => a.x - b.x);
  if (pts.length < 6) return null;
  const fit = chebFit(pts);
  let sq = 0;
  for (const p of pts) sq += (p.y - fit.evalAt(p.x)) ** 2;
  const residRms = Math.sqrt(sq / pts.length);
  const evalAtSafe = (x: number) => {
    if (x < pts[0].x) return pts[0].y + (x - pts[0].x) * edgeSlope(pts, 'start');
    if (x > pts[pts.length - 1].x) return pts[pts.length - 1].y + (x - pts[pts.length - 1].x) * edgeSlope(pts, 'end');
    return fit.evalAt(x);
  };
  return { pts, startX: pts[0].x, endX: pts[pts.length - 1].x, fitDeg: fit.deg, residRms, evalAt: fit.evalAt, evalAtSafe };
}

/**
 * Stafflinien-Erkennung als Polynomfamilien über vertikale Streifen.
 *
 * Die pixelgenaue Tracker-Variante kann bei Fotos scheitern, wenn Linien durch
 * Perspektive, Druckraster oder Noten überdeckt sind. Diese Variante misst in
 * vielen schmalen X-Streifen die horizontalen Projektionsspitzen, verknüpft
 * diese Peaks zu Kurven und fitet daraus Polynome. Das ist genau die Struktur,
 * die wir später fürs Keystoning/Entwölben brauchen.
 */
export function estimatePolynomialStaffGrid(canvas: HTMLCanvasElement): GridResult {
  const small = downscale(canvas, 1300, true);
  const w = small.width, h = small.height;
  const bin = closeH(binarizeAdaptive(small, 0.05, 0.66), w, h, 3);
  const analysisX0 = Math.floor(w * 0.12);
  const analysisX1 = w - 1;
  const analysisW = analysisX1 - analysisX0 + 1;
  const stripCount = Math.max(18, Math.min(48, Math.round(analysisW / 34)));
  const stripW = analysisW / stripCount;

  type Cand = { strip: number; x: number; y: number; score: number; used?: boolean };
  const byStrip: Cand[][] = [];
  const seedLike: { x: number; y: number }[] = [];

  for (let s = 0; s < stripCount; s++) {
    const x0 = analysisX0 + Math.floor(s * stripW);
    const x1 = Math.min(analysisX1, Math.max(x0, analysisX0 + Math.floor((s + 1) * stripW) - 1));
    const sw = x1 - x0 + 1;
    const prof = new Float64Array(h);
    for (let y = 0; y < h; y++) {
      let c = 0;
      const off = y * w;
      for (let x = x0; x <= x1; x++) if (bin[off + x]) c++;
      prof[y] = c;
    }
    const smoothP = new Float64Array(h);
    for (let y = 0; y < h; y++) {
      let sm = 0, n = 0;
      for (let k = -1; k <= 1; k++) {
        const yy = y + k;
        if (yy >= 0 && yy < h) { sm += prof[yy]; n++; }
      }
      smoothP[y] = sm / Math.max(1, n);
    }
    const vals = Array.from(smoothP).sort((a, b) => a - b);
    const q88 = vals[Math.floor(vals.length * 0.88)] ?? 0;
    // Streifen sind schmal; eine echte Stafflinie kann dort nur wenige dunkle
    // Pixel breit sein. Schwelle deshalb bewusst niedrig, nachher filtern
    // Tracking/5er-Gruppierung die Text- und Rauschpeaks heraus.
    const threshold = Math.max(1.1, sw * 0.032, q88 * 0.72);
    const cands: Cand[] = [];
    let y = 1;
    while (y < h - 1) {
      if (smoothP[y] >= threshold && smoothP[y] >= smoothP[y - 1] && smoothP[y] >= smoothP[y + 1]) {
        let y0 = y, y1 = y;
        while (y0 > 0 && smoothP[y0 - 1] >= threshold * 0.72) y0--;
        while (y1 < h - 1 && smoothP[y1 + 1] >= threshold * 0.72) y1++;
        let sum = 0, wy = 0, mx = 0;
        for (let yy = y0; yy <= y1; yy++) { sum += smoothP[yy]; wy += smoothP[yy] * yy; if (smoothP[yy] > mx) mx = smoothP[yy]; }
        const cy = sum > 0 ? wy / sum : y;
        if ((y1 - y0 + 1) <= Math.max(5, h * 0.01)) {
          const cand = { strip: s, x: (x0 + x1) / 2, y: cy, score: mx };
          cands.push(cand);
          seedLike.push({ x: cand.x, y: cand.y });
        }
        y = y1 + 2;
      } else y++;
    }
    // Nicht zu viele Text-/Rauschpeaks pro Streifen behalten.
    cands.sort((a, b) => b.score - a.score);
    byStrip.push(cands.slice(0, 90).sort((a, b) => a.y - b.y));
  }

  // Spatium aus kleinen Nachbarabständen je Streifen. Größere Abstände
  // zwischen Systemen/Textzeilen dürfen den Modus nicht dominieren.
  const gapBins = new Map<number, { count: number; sum: number }>();
  for (const cands of byStrip) {
    const ys = cands.map(c => c.y).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) {
      const d = ys[i] - ys[i - 1];
      if (d >= Math.max(3, h * 0.003) && d <= h * 0.032) {
        const b = Math.round(d);
        const cur = gapBins.get(b) ?? { count: 0, sum: 0 };
        gapBins.set(b, { count: cur.count + 1, sum: cur.sum + d });
      }
    }
  }
  let spatiumPx = 0;
  let bestGapCount = 0;
  for (const v of gapBins.values()) {
    if (v.count > bestGapCount) { bestGapCount = v.count; spatiumPx = v.sum / v.count; }
  }
  if (!spatiumPx) spatiumPx = estimateSpatium(seedLike, h);
  if (spatiumPx < Math.max(4, h * 0.003) || spatiumPx > h * 0.04) {
    return { staves: [], spatiumPx, coverage: 0, reason: `Poly: kein Spatium (sp=${spatiumPx.toFixed(1)}, peaks=${seedLike.length}, gapBins=${gapBins.size})`, overlay: null };
  }

  type PTrack = { pts: TrackPt[]; lastStrip: number; lastY: number; score: number };
  const tracks: PTrack[] = [];
  const maxDelta = Math.max(4, spatiumPx * 0.72);
  for (let s = 0; s < stripCount; s++) {
    const cands = byStrip[s];
    cands.forEach(c => { c.used = false; });
    const active = tracks
      .filter(t => s - t.lastStrip <= 4)
      .sort((a, b) => b.pts.length - a.pts.length || b.score - a.score);

    for (const tr of active) {
      const gap = s - tr.lastStrip;
      let pred = tr.lastY;
      if (tr.pts.length >= 2) {
        const a = tr.pts[tr.pts.length - 2], b = tr.pts[tr.pts.length - 1];
        const dx = b.x - a.x;
        if (Math.abs(dx) > 1e-6) pred = b.y + ((b.y - a.y) / dx) * (((s + 0.5) * stripW) - b.x);
      }
      let best: Cand | null = null;
      let bestD = Infinity;
      for (const c of cands) {
        if (c.used) continue;
        const d = Math.abs(c.y - pred);
        if (d < bestD && d <= maxDelta * Math.max(1, gap * 1.25)) { bestD = d; best = c; }
      }
      if (best) {
        best.used = true;
        tr.pts.push({ x: best.x, y: best.y });
        tr.lastStrip = s;
        tr.lastY = best.y;
        tr.score += best.score;
      }
    }

    for (const c of cands) {
      if (!c.used && c.score >= Math.max(1.4, (stripW * 0.045))) {
        tracks.push({ pts: [{ x: c.x, y: c.y }], lastStrip: s, lastY: c.y, score: c.score });
      }
    }
  }

  const minPts = Math.max(4, Math.floor(stripCount * 0.14));
  const rawTraj = tracks
    .filter(t => t.pts.length >= minPts)
    .map(t => trajectoryFromPolynomialPts(t.pts, w))
    .filter((t): t is Trajectory => !!t)
    .filter(t => (t.endX - t.startX) >= w * 0.10 && t.residRms <= Math.max(5.0, spatiumPx * 1.15));

  if (rawTraj.length < 12) {
    return { staves: [], spatiumPx, coverage: 0, reason: `Poly: nur ${rawTraj.length} Kurven aus ${tracks.length} Tracks (sp=${spatiumPx.toFixed(1)})`, overlay: null };
  }

  const cx = w / 2;
  const sorted = rawTraj.slice().sort((a, b) => a.evalAtSafe(cx) - b.evalAtSafe(cx));
  const rowsBest: Trajectory[] = [];
  for (const t of sorted) {
    const last = rowsBest[rowsBest.length - 1];
    if (last && Math.abs(t.evalAtSafe(cx) - last.evalAtSafe(cx)) < spatiumPx * 0.45) {
      const lastQuality = (last.endX - last.startX) / Math.max(0.5, last.residRms);
      const thisQuality = (t.endX - t.startX) / Math.max(0.5, t.residRms);
      if (thisQuality > lastQuality) rowsBest[rowsBest.length - 1] = t;
    } else rowsBest.push(t);
  }

  const staves: { rows: Trajectory[] }[] = [];
  const used = new Set<number>();
  for (let i = 0; i <= rowsBest.length - 5; i++) {
    if (used.has(i)) continue;
    const seq = [i];
    let lastY = rowsBest[i].evalAtSafe(cx);
    for (let j = i + 1; j < rowsBest.length && seq.length < 5; j++) {
      if (used.has(j)) continue;
      const dy = rowsBest[j].evalAtSafe(cx) - lastY;
      if (dy < spatiumPx * 0.45) continue;
      if (dy > spatiumPx * 1.65) break;
      seq.push(j);
      lastY = rowsBest[j].evalAtSafe(cx);
    }
    if (seq.length === 5) {
      const gaps = seq.slice(1).map((idx, k) => rowsBest[idx].evalAtSafe(cx) - rowsBest[seq[k]].evalAtSafe(cx));
      const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const maxDev = Math.max(...gaps.map(g => Math.abs(g - avgGap)));
      if (avgGap > spatiumPx * 0.55 && avgGap < spatiumPx * 1.45 && maxDev < avgGap * 0.38) {
        const five = seq.map(idx => rowsBest[idx]);
        const cover = Math.max(...five.map(t => t.endX)) - Math.min(...five.map(t => t.startX));
        if (cover >= w * 0.22) {
          seq.forEach(idx => used.add(idx));
          staves.push({ rows: five });
          i = seq[seq.length - 1];
        }
      }
    }
  }

  if (staves.length === 0) {
    return { staves: [], spatiumPx, coverage: 0, reason: `Poly: keine 5er-Staffeln aus ${rowsBest.length} Kurven (raw=${rawTraj.length}, sp=${spatiumPx.toFixed(1)})`, overlay: null };
  }

  const minX = Math.min(...staves.flatMap(st => st.rows.map(t => t.startX)));
  const maxX = Math.max(...staves.flatMap(st => st.rows.map(t => t.endX)));
  const coverage = (maxX - minX) / w;
  const overlay = document.createElement('canvas');
  overlay.width = w; overlay.height = h;
  const octx = overlay.getContext('2d')!;
  octx.drawImage(small, 0, 0);
  octx.strokeStyle = '#ef4444';
  octx.lineWidth = 2;
  for (const st of staves) for (const t of st.rows) {
    octx.beginPath();
    octx.moveTo(t.startX, t.evalAtSafe(t.startX));
    for (let x = t.startX; x <= t.endX; x += 6) octx.lineTo(x, t.evalAtSafe(x));
    octx.stroke();
  }
  return { staves, spatiumPx, coverage, overlay };
}

// Entzerrung ueber die gemessenen Trajektorien (Y-Achse)
export function dewarpByTracks(canvas: HTMLCanvasElement, grid: GridResult): HTMLCanvasElement {
  const small = downscale(canvas, 1300);
  const W = small.width, H = small.height;
  const octx0 = small.getContext('2d')!;
  const sd = octx0.getImageData(0, 0, W, H).data;
  const spOut = grid.spatiumPx;
  const cx = W / 2;

  // Zeilenliste in aufsteigender Reihenfolge (Staffel j, Zeile k), jeweils eine
  // gemessene Trajektorie (zusammengefasst als Mittel der Cluster-Trajektorien)
  const rowsAsc: { yAt: (x: number) => number }[] = [];
  grid.staves
    .slice()
    .sort((a, b) => a.rows[0].evalAt(cx) - b.rows[0].evalAt(cx))
    .forEach(st => {
      st.rows
        .slice()
        .sort((l1, l2) => l1.evalAt(cx) - l2.evalAt(cx))
        .forEach((t, k, arr) => {
          rowsAsc.push({ yAt: (x: number) => t.evalAtSafe(x) });
        });
    });
  const nRows = rowsAsc.length;
  if (nRows < 5) return canvas;

  const yBase = spOut;
  const outHh = Math.max(1, Math.ceil((nRows - 1) * spOut + 2 * spOut));
  const out = document.createElement('canvas');
  out.width = W; out.height = outHh;
  const octx = out.getContext('2d')!;
  octx.fillStyle = 'white';
  octx.fillRect(0, 0, W, outHh);
  const oimg = octx.getImageData(0, 0, W, outHh);
  const od = oimg.data;

  const sample = (sx: number, sy: number): [number, number, number] => {
    const x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(W - 1, x0 + 1);
    const y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(H - 1, y0 + 1);
    const dx = sx - x0, dy = sy - y0;
    const i00 = (y0 * W + x0) * 4, i01 = (y0 * W + x1) * 4, i10 = (y1 * W + x0) * 4, i11 = (y1 * W + x1) * 4;
    const r: [number, number, number] = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const c00 = sd[i00 + c], c01 = sd[i01 + c], c10 = sd[i10 + c], c11 = sd[i11 + c];
      r[c] = c00 * (1 - dx) * (1 - dy) + c01 * dx * (1 - dy) + c10 * (1 - dx) * dy + c11 * dx * dy;
    }
    return r;
  };

  for (let y = 0; y < outHh; y++) {
    const rIdx = (y - yBase) / spOut;
    let i0 = Math.floor(rIdx);
    if (i0 < -1) i0 = -1;
    if (i0 > nRows - 2) i0 = nRows - 2;
    const t = Math.min(1, Math.max(0, rIdx - i0));
    for (let x = 0; x < W; x++) {
      let srcY: number;
      if (i0 < 0) srcY = rowsAsc[0].yAt(x) + rIdx * (rowsAsc[1].yAt(x) - rowsAsc[0].yAt(x));
      else if (i0 >= nRows - 1) { const a = rowsAsc[nRows - 2].yAt(x), b = rowsAsc[nRows - 1].yAt(x); srcY = b + (rIdx - (nRows - 1)) * (b - a); }
      else { const a = rowsAsc[i0].yAt(x), b = rowsAsc[i0 + 1].yAt(x); srcY = a + (b - a) * t; }
      const [cr, cg, cb] = sample(x, srcY);
      const idx = (y * W + x) * 4;
      od[idx] = cr; od[idx + 1] = cg; od[idx + 2] = cb; od[idx + 3] = 255;
    }
  }
  octx.putImageData(oimg, 0, 0);

  const sc = canvas.width / small.width;
  if (sc !== 1) {
    const big = document.createElement('canvas');
    big.width = canvas.width; big.height = Math.round(outHh * sc);
    big.getContext('2d')!.drawImage(out, 0, 0, big.width, big.height);
    return big;
  }
  return out;
}

// Layout-erhaltende lokale Staff-Entwölbung: Anders als dewarpByTracks() wird
// die Seite NICHT auf ein neues Notenraster zusammengedrückt. Stattdessen werden
// nur lokale Y-Verschiebungen in der Nähe erkannter Stafflinien angewandt, sodass
// gekrümmte Linien an ihrer vorhandenen Seitenposition geglättet werden.
export function straightenStaffBands(canvas: HTMLCanvasElement, grid: GridResult): { canvas: HTMLCanvasElement; evidence: string } {
  if (!grid.overlay || grid.staves.length < 4 || grid.spatiumPx <= 0) {
    return { canvas, evidence: `kein lokales Entwölben (staves=${grid.staves.length}, sp=${grid.spatiumPx.toFixed(1)})` };
  }

  const W = canvas.width, H = canvas.height;
  const smallW = grid.overlay.width, smallH = grid.overlay.height;
  const sx = W / smallW, sy = H / smallH;
  const sp = grid.spatiumPx * sy;
  const cx = smallW / 2;

  type RowRef = { targetY: number; startX: number; endX: number; deltaAt: (xSmall: number) => number };
  const rows: RowRef[] = [];
  for (const st of grid.staves) {
    for (const t of st.rows) {
      const midX = clampNum(cx, t.startX, t.endX);
      const targetY = t.evalAtSafe(midX) * sy;
      rows.push({
        targetY,
        startX: Math.max(0, t.startX - grid.spatiumPx * 5),
        endX: Math.min(smallW - 1, t.endX + grid.spatiumPx * 5),
        deltaAt: (xSmall: number) => (t.evalAtSafe(xSmall) * sy) - targetY,
      });
    }
  }
  rows.sort((a, b) => a.targetY - b.targetY);
  if (rows.length < 20) return { canvas, evidence: `zu wenige Staff-Zeilen (${rows.length})` };

  const maxAbsDelta = sp * 2.2;
  const bandRadius = sp * 2.4;
  const sigma = sp * 0.95;
  const sctx = canvas.getContext('2d')!;
  const src = sctx.getImageData(0, 0, W, H);
  const sd = src.data;
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const octx = out.getContext('2d')!;
  const oimg = octx.createImageData(W, H);
  const od = oimg.data;

  const sample = (x: number, y: number): [number, number, number] => {
    const yy = clampNum(y, 0, H - 1);
    const y0 = Math.floor(yy), y1 = Math.min(H - 1, y0 + 1);
    const dy = yy - y0;
    const i0 = (y0 * W + x) * 4;
    const i1 = (y1 * W + x) * 4;
    return [
      sd[i0] * (1 - dy) + sd[i1] * dy,
      sd[i0 + 1] * (1 - dy) + sd[i1 + 1] * dy,
      sd[i0 + 2] * (1 - dy) + sd[i1 + 2] * dy,
    ];
  };

  let correctedRows = 0;
  for (let y = 0; y < H; y++) {
    const candidates = rows.filter(r => Math.abs(r.targetY - y) <= bandRadius);
    if (candidates.length === 0) {
      od.set(sd.subarray(y * W * 4, (y + 1) * W * 4), y * W * 4);
      continue;
    }
    correctedRows++;
    for (let x = 0; x < W; x++) {
      const xSmall = x / sx;
      let sumW = 0;
      let sumD = 0;
      for (const r of candidates) {
        if (xSmall < r.startX || xSmall > r.endX) continue;
        const dist = y - r.targetY;
        const wt = Math.exp(-(dist * dist) / (2 * sigma * sigma));
        if (wt < 0.005) continue;
        sumW += wt;
        sumD += wt * clampNum(r.deltaAt(xSmall), -maxAbsDelta, maxAbsDelta);
      }
      const dst = (y * W + x) * 4;
      if (sumW <= 0) {
        const srcIdx = dst;
        od[dst] = sd[srcIdx]; od[dst + 1] = sd[srcIdx + 1]; od[dst + 2] = sd[srcIdx + 2]; od[dst + 3] = 255;
      } else {
        const delta = sumD / sumW;
        const [r, g, b] = sample(x, y + delta);
        od[dst] = r; od[dst + 1] = g; od[dst + 2] = b; od[dst + 3] = 255;
      }
    }
  }

  octx.putImageData(oimg, 0, 0);
  return { canvas: out, evidence: `lokal entwölbt: ${grid.staves.length} Staffeln/${rows.length} Zeilen, ${correctedRows} Bildzeilen korrigiert, sp=${sp.toFixed(1)}px` };
}

// Layout-erhaltende Seitenentwölbung über Spalten-Projektionen. Für jede
// vertikale Bildspalte/Strip wird gemessen, um wie viele Pixel die horizontalen
// Stafflinien gegenüber dem globalen Referenzprofil nach oben/unten verschoben
// sind. Dann wird nur eine sanfte Y-Verschiebung pro X angewandt. Das ist keine
// Notenraster-Kompression und kann schon helfen, lokale Buchwölbung/Treppen zu
// reduzieren, wenn die volle Staff-Track-Erkennung noch nicht stabil genug ist.
export function straightenByColumnProjection(canvas: HTMLCanvasElement): { canvas: HTMLCanvasElement; evidence: string } {
  const pixels = canvas.width * canvas.height;
  // Vollauflösende Spalten-Warps brauchen mehrere große RGBA-Puffer. In der
  // aktuellen Browser/Sandbox-Speichergrenze nur auf kleineren Seiten aktivieren;
  // sonst sicher überspringen statt die App zu killen.
  if (pixels > 10_000_000) return { canvas, evidence: `Spalten-Entwölbung übersprungen (Speicherschutz ${(pixels / 1_000_000).toFixed(1)}MP)` };
  const small = downscale(canvas, 1000, true);
  const w = small.width, h = small.height;
  const bin = closeH(binarizeAdaptive(small, 0.05, 0.64), w, h, 3);
  const stripCount = clampNum(Math.round(w / 38), 14, 40);
  const stripW = w / stripCount;
  const profiles: Float64Array[] = [];
  const ref = new Float64Array(h);

  for (let s = 0; s < stripCount; s++) {
    const x0 = Math.floor(s * stripW);
    const x1 = Math.min(w - 1, Math.floor((s + 1) * stripW) - 1);
    const prof = new Float64Array(h);
    for (let y = 0; y < h; y++) {
      let c = 0;
      const off = y * w;
      for (let x = x0; x <= x1; x++) if (bin[off + x]) c++;
      prof[y] = c;
      ref[y] += c;
    }
    profiles.push(prof);
  }

  // Vertikal glätten: Projektionsspitzen bleiben, Noten-/Textsalz wird ruhiger.
  const smooth = (arr: Float64Array, rad = 2): Float64Array => {
    const out = new Float64Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      let s = 0, n = 0;
      for (let k = -rad; k <= rad; k++) {
        const j = i + k;
        if (j >= 0 && j < arr.length) { s += arr[j]; n++; }
      }
      out[i] = s / Math.max(1, n);
    }
    return out;
  };
  const refS = smooth(ref, 2);
  const maxShift = Math.max(6, Math.round(h * 0.035));
  const shiftsSmall: number[] = [];
  const strengths: number[] = [];

  for (const prof0 of profiles) {
    const prof = smooth(prof0, 2);
    let bestD = 0;
    let bestScore = -Infinity;
    let zeroScore = 0;
    for (let d = -maxShift; d <= maxShift; d++) {
      let score = 0;
      for (let y = Math.max(0, -d); y < Math.min(h, h - d); y++) {
        score += prof[y + d] * refS[y];
      }
      if (d === 0) zeroScore = score;
      if (score > bestScore) { bestScore = score; bestD = d; }
    }
    // Schwache/unklare Spalten nicht überkorrigieren.
    const strength = zeroScore > 0 ? bestScore / zeroScore : 1;
    shiftsSmall.push(strength > 1.015 ? bestD : 0);
    strengths.push(strength);
  }

  // Robust glätten, damit keine Strip-Kanten entstehen.
  const smoothShifts = shiftsSmall.map((_, i) => {
    const vals: number[] = [];
    for (let k = -2; k <= 2; k++) {
      const j = clampNum(i + k, 0, stripCount - 1);
      vals.push(shiftsSmall[j]);
    }
    vals.sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)];
  });
  const avgAbs = smoothShifts.reduce((s, v) => s + Math.abs(v), 0) / smoothShifts.length;
  if (avgAbs < 0.35) return { canvas, evidence: `Spalten-Entwölbung übersprungen (avgShift=${avgAbs.toFixed(2)}px)` };

  const W = canvas.width, H = canvas.height;
  const scaleY = H / h;
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const sctx = canvas.getContext('2d')!;
  const src = sctx.getImageData(0, 0, W, H);
  const sd = src.data;
  const octx = out.getContext('2d')!;
  const oimg = octx.createImageData(W, H);
  const od = oimg.data;

  const shiftAtX = (x: number): number => {
    const pos = (x / W) * stripCount - 0.5;
    const i0 = clampNum(Math.floor(pos), 0, stripCount - 1);
    const i1 = clampNum(i0 + 1, 0, stripCount - 1);
    const t = clampNum(pos - i0, 0, 1);
    return (smoothShifts[i0] * (1 - t) + smoothShifts[i1] * t) * scaleY;
  };
  const sample = (x: number, y: number): [number, number, number] => {
    const yy = clampNum(y, 0, H - 1);
    const y0 = Math.floor(yy), y1 = Math.min(H - 1, y0 + 1);
    const dy = yy - y0;
    const i0 = (y0 * W + x) * 4;
    const i1 = (y1 * W + x) * 4;
    return [
      sd[i0] * (1 - dy) + sd[i1] * dy,
      sd[i0 + 1] * (1 - dy) + sd[i1 + 1] * dy,
      sd[i0 + 2] * (1 - dy) + sd[i1 + 2] * dy,
    ];
  };

  for (let x = 0; x < W; x++) {
    const sh = clampNum(shiftAtX(x), -maxShift * scaleY, maxShift * scaleY);
    for (let y = 0; y < H; y++) {
      const [r, g, b] = sample(x, y + sh);
      const i = (y * W + x) * 4;
      od[i] = r; od[i + 1] = g; od[i + 2] = b; od[i + 3] = 255;
    }
  }
  octx.putImageData(oimg, 0, 0);
  return { canvas: out, evidence: `Spalten-Entwölbung avg=${avgAbs.toFixed(2)}px max=${Math.max(...smoothShifts.map(v => Math.abs(v))).toFixed(1)}px strips=${stripCount}` };
}
