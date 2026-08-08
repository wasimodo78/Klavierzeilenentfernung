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
  const small = downscale(canvas, 900);
  const bin0 = binarize(small);
  const sharpOf = (deg: number): number => {
    const r = rotateBinary(bin0, small.width, small.height, deg);
    let score = 0;
    for (let y = 0; y < r.h; y += 2) {
      let b = 0;
      const o = y * r.w;
      for (let x = 0; x < r.w; x++) b += r.bin[o + x];
      score += b * b;
    }
    return score;
  };
  let best = 0, bestScore = -Infinity;
  const coarse: [number, number][] = [];
  for (let a = -20; a <= 20; a += 1) {
    const s = sharpOf(a);
    coarse.push([a, s]);
    if (s > bestScore) { bestScore = s; best = a; }
  }
  for (let a = best - 0.75; a <= best + 0.75; a += 0.05) {
    const s = sharpOf(a);
    if (s > bestScore) { bestScore = s; best = a; }
  }
  // Falls der beste Grobwert am Rand liegt (-20/20), nicht vorzeitig glauben
  const edge = Math.abs(best) >= 19.9;
  return { angleDeg: edge ? best : best, votes: coarse.map(([a, s]) => `${a}°:${(s / 1e9).toFixed(2)}`).join(' ') + (edge ? ' [RAND!]' : '') };
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
export function downscale(src: HTMLCanvasElement, maxDim: number): HTMLCanvasElement {
  const f = Math.min(1, maxDim / Math.max(src.width, src.height));
  if (f >= 1) {
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    c.getContext('2d')!.drawImage(src, 0, 0);
    return c;
  }
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * f); c.height = Math.round(src.height * f);
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

// --- Orchestrierte Normalisierung (Stufe 1) ---------------------------------
export async function restoreScanImage(srcCanvas: HTMLCanvasElement): Promise<RestoredPage[]> {
  const debug: ScanDebug = {
    orientationVotes: '', fineAngleDeg: 0, split: 'einseitig', splitColumnX: null, splitEvidence: '', stageImages: []
  };

  debug.stageImages.push({ label: 'Original', dataUrl: downscale(srcCanvas, 700).toDataURL('image/jpeg', 0.75) });

  // 1. Groborientierung (inkl. 90°!)
  const o = estimateOrientation90(srcCanvas);
  debug.orientationVotes = o.votes;
  let work = srcCanvas;
  if (o.rotate90) {
    const r = document.createElement('canvas');
    r.width = srcCanvas.height; r.height = srcCanvas.width;
    const rctx = r.getContext('2d')!;
    rctx.translate(r.width / 2, r.height / 2);
    rctx.rotate(Math.PI / 2);
    rctx.drawImage(srcCanvas, -srcCanvas.width / 2, -srcCanvas.height / 2);
    work = r;
  }

  // 2. Feinwinkel
  const fa = estimateFineAngle(work);
  debug.fineAngleDeg = fa.angleDeg;
  if (fa.angleDeg !== 0) work = rotateCanvas(work, fa.angleDeg);
  debug.stageImages.push({ label: `Ausgerichtet (${o.rotate90 ? '90°+' : ''}${fa.angleDeg.toFixed(2)}°)`, dataUrl: downscale(work, 700).toDataURL('image/jpeg', 0.75) });

  // 3. Geometrie: Prediktiv-Spur-Gitter (Innen nach aussen) zuerst; Kontur-Fallback.
  const trackGrid = estimateTrackGrid(work);
  if (trackGrid.coverage >= 0.4 && trackGrid.staves.length >= 2) {
    debug.stageImages.push({ label: `Spur-Gitter (${trackGrid.staves.length} Staffeln, Spatium ${trackGrid.spatiumPx.toFixed(1)}px, Abdeckung ${(trackGrid.coverage * 100).toFixed(0)}%)`, dataUrl: trackGrid.overlay ? trackGrid.overlay.toDataURL('image/jpeg', 0.75) : '' });
    work = dewarpByTracks(work, trackGrid);
    debug.stageImages.push({ label: 'Entwölbt (Spur)', dataUrl: downscale(work, 700).toDataURL('image/jpeg', 0.75) });
  } else {
    debug.splitEvidence += `[kein Spur-Gitter: ${trackGrid.reason || 'unbekannt'}] `;
    const pc = detectPageCorners(work);
  if (pc.corners) {
    // Rahmen-Kopie erkennen: Alle Ecken nahe am Bildrand -> Homographie ~Identitaet (kein Gewinn, aber auch kein Risiko)
    const smallW = downscale(work, 900);
    const near = (p: [number, number]) => Math.min(p[0], p[1], smallW.width - p[0], smallW.height - p[1]) < smallW.width * 0.04;
    const allNear = pc.corners.every(near);
    if (allNear) debug.splitEvidence += '[Kontur=Rahmen, homographie identisch] ';
    // Ausgabeformat: Seitenverhaeltnis aus Ecken-Geometrie schätzen, sonst A4-Quer/Port je Lage
    const estW = Math.max( Math.hypot(pc.corners[1][0]-pc.corners[0][0], pc.corners[1][1]-pc.corners[0][1]), Math.hypot(pc.corners[2][0]-pc.corners[3][0], pc.corners[2][1]-pc.corners[3][1]) );
    const estH = Math.max( Math.hypot(pc.corners[3][0]-pc.corners[0][0], pc.corners[3][1]-pc.corners[0][1]), Math.hypot(pc.corners[2][0]-pc.corners[1][0], pc.corners[2][1]-pc.corners[1][1]) );
    const tgtW = Math.min(2400, Math.round(estW * 3.2));
    const tgtH = Math.min(3400, Math.round(estH * 3.2));
    work = rectifyPerspective(work, pc.corners, tgtW, tgtH);
    debug.stageImages.push({ label: 'Perspektive entzerrt (Kontur)', dataUrl: downscale(work, 700).toDataURL('image/jpeg', 0.75) });
    debug.splitEvidence = (pc.corners ? 'Kontur OK. ' : 'Kontur nicht sicher (' + pc.evidence + '). ');
  }
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

  // 5. Illuminations-Normalisierung je Halbseite
  const results: RestoredPage[] = [];
  halves.forEach((hc, idx) => {
    const norm = normalizeIllumination(hc);
    if (idx === 0) debug.stageImages.push({ label: 'Schatten entfernt', dataUrl: downscale(norm, 700).toDataURL('image/jpeg', 0.75) });
    results.push({ canvas: norm, debug });
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
      const five = seq.map(g => rowsBest[g]);
      let okOverlap = true;
      for (let a = 0; a < 4; a++) {
        if (overlapWidth(five[a], five[a + 1]) < w * 0.25) { okOverlap = false; break; }
      }
      if (okOverlap) {
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
