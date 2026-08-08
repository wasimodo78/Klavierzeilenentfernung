import * as pdfjsLib from 'pdfjs-dist';
import { jsPDF } from 'jspdf';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url';

// Bundle the pdf.js worker locally so the app works fully offline (no CDN needed).
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

type Region = { start: number; end: number; type: 'ink' | 'gap' };

export type ExtractedSystem = { dataUrl: string; width: number; height: number };

export async function extractSystems(
  file: File,
  onProgress: (msg: string, percent: number) => void
): Promise<ExtractedSystem[]> {
  onProgress("Lade PDF...", 5);

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const numPages = pdf.numPages;

  const croppedImages: ExtractedSystem[] = [];

  for (let i = 1; i <= numPages; i++) {
    onProgress(`Analysiere Seite ${i} von ${numPages}...`, 10 + (i / numPages) * 80);

    const page = await pdf.getPage(i);
    
    // High resolution for the final cropped image extraction
    const viewport = page.getViewport({ scale: 2.0 });
    // Low resolution for fast density analysis
    const analysisViewport = page.getViewport({ scale: 0.5 });

    // Render high-res
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    await page.render({ canvasContext: ctx, viewport }).promise;

    // Render low-res for analysis
    const aCanvas = document.createElement('canvas');
    aCanvas.width = analysisViewport.width;
    aCanvas.height = analysisViewport.height;
    const aCtx = aCanvas.getContext('2d', { willReadFrequently: true })!;
    await page.render({ canvasContext: aCtx, viewport: analysisViewport }).promise;

    // Analyze low-res density
    const imageData = aCtx.getImageData(0, 0, aCanvas.width, aCanvas.height);
    const data = imageData.data;
    const rowDensities = new Float32Array(aCanvas.height);

    // Ignore 8% on left and 5% on right to prevent border lines / brackets from messing up analysis
    const marginXLeft = Math.floor(aCanvas.width * 0.08);
    const marginXRight = Math.floor(aCanvas.width * 0.05);
    const validWidth = aCanvas.width - marginXLeft - marginXRight;

    for (let y = 0; y < aCanvas.height; y++) {
      let darkPixelCount = 0;
      for (let x = marginXLeft; x < aCanvas.width - marginXRight; x++) {
        const idx = (y * aCanvas.width + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        // Calculate lightness (0 = black, 255 = white)
        const lightness = (r + g + b) / 3;
        if (lightness < 200) {
          darkPixelCount++;
        }
      }
      rowDensities[y] = darkPixelCount;
    }

    // Smooth densities slightly
    const smoothed = new Float32Array(aCanvas.height);
    const windowSize = Math.max(1, Math.floor(aCanvas.height * 0.003));
    for (let y = 0; y < aCanvas.height; y++) {
      let sum = 0;
      let count = 0;
      for (let dy = -windowSize; dy <= windowSize; dy++) {
        if (y + dy >= 0 && y + dy < aCanvas.height) {
          sum += rowDensities[y + dy];
          count++;
        }
      }
      smoothed[y] = sum / count;
    }

    // --- 1. Find Staff Lines and Staves (Robust against tilt/empty staves) ---
    // A single staff line should be at least ~15% of the page width.
    const staffLineThreshold = validWidth * 0.15;
    const isStaffRow = new Uint8Array(aCanvas.height);
    for (let y = 0; y < aCanvas.height; y++) {
      if (rowDensities[y] > staffLineThreshold) isStaffRow[y] = 1;
    }

    const STAFF_MERGE_GAP = aCanvas.height * 0.015; // 1.5% gap (~4.5mm)
    const staves: {start: number, end: number, score: number}[] = [];
    let currStaff: {start: number, end: number, score: number} | null = null;
    
    for (let y = 0; y < aCanvas.height; y++) {
      if (isStaffRow[y]) {
        if (!currStaff) {
          currStaff = { start: y, end: y, score: rowDensities[y] };
        } else if (y - currStaff.end <= STAFF_MERGE_GAP) {
          currStaff.end = y;
          currStaff.score += rowDensities[y];
        } else {
          staves.push(currStaff);
          currStaff = { start: y, end: y, score: rowDensities[y] };
        }
      } else if (currStaff && y - currStaff.end <= STAFF_MERGE_GAP) {
        // Accumulate score for gaps inside the staff
        currStaff.score += rowDensities[y];
      }
    }
    if (currStaff) staves.push(currStaff);

    // A real 5-line staff must be at least ~3mm tall and have enough total black pixels
    const MIN_STAFF_HEIGHT = aCanvas.height * 0.01; 
    const validStaves = staves.filter(s => {
      const h = s.end - s.start;
      return h >= MIN_STAFF_HEIGHT && s.score > validWidth * 1.5;
    });

    // --- 2. Create Content Profile ---
    const maxSmoothed = Math.max(...Array.from(smoothed));
    const contentThreshold = Math.max(maxSmoothed * 0.05, validWidth * 0.01);
    
    const contentRows = new Uint8Array(aCanvas.height);
    for (let y = 0; y < aCanvas.height; y++) {
      if (smoothed[y] > contentThreshold) contentRows[y] = 1;
    }

    const MIN_GAP_CONTENT = aCanvas.height * 0.01; // Merge within ~3mm
    const contentBlocks: {start: number, end: number}[] = [];
    let currContent: {start: number, end: number} | null = null;
    for (let y = 0; y < aCanvas.height; y++) {
      if (contentRows[y]) {
        if (!currContent) currContent = { start: y, end: y };
        else if (y - currContent.end <= MIN_GAP_CONTENT) currContent.end = y;
        else {
          contentBlocks.push(currContent);
          currContent = { start: y, end: y };
        }
      }
    }
    if (currContent) contentBlocks.push(currContent);

    // --- 3. Group Blocks into Systems ---
    if (validStaves.length === 0) {
      // No staves found, likely a title page. Keep the whole page.
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      croppedImages.push({ dataUrl, width: canvas.width, height: canvas.height });
      continue;
    }

    // A system gap is larger than 3.5% of page height of pure whitespace
    const SYSTEM_GAP = aCanvas.height * 0.035; 
    const systems: {start: number, end: number, staves: {start: number, end: number}[]}[] = [];
    let currSystem: {start: number, end: number} | null = null;
    
    for (const b of contentBlocks) {
      if (!currSystem) {
        currSystem = { start: b.start, end: b.end };
      } else if (b.start - currSystem.end <= SYSTEM_GAP) {
        currSystem.end = b.end;
      } else {
        systems.push({ start: currSystem.start, end: currSystem.end, staves: [] });
        currSystem = { start: b.start, end: b.end };
      }
    }
    if (currSystem) systems.push({ start: currSystem.start, end: currSystem.end, staves: [] });

    // Assign staves to systems
    for (const staff of validStaves) {
      for (const sys of systems) {
        if (staff.start >= sys.start - MIN_GAP_CONTENT && staff.end <= sys.end + MIN_GAP_CONTENT) {
          sys.staves.push(staff);
          break;
        }
      }
    }

    // --- 5. Cut Piano Accompaniment ---
    const scale = canvas.height / aCanvas.height;
    
    for (const sys of systems) {
      let cutY = sys.end;

      if (sys.staves.length <= 2) {
        // Pure piano system (intro, interlude). Keep it so singer has context.
        cutY = sys.end;
      } else if (sys.staves.length >= 3) {
        const pianoRH = sys.staves[sys.staves.length - 2];
        const lastVocal = sys.staves[sys.staves.length - 3];
        
        let maxGapStart = -1;
        let maxGapLength = 0;
        let currentGapStart = -1;
        
        const searchStart = lastVocal.end;
        const searchEnd = pianoRH.start;
        
        if (searchEnd > searchStart) {
          for (let y = searchStart; y <= searchEnd; y++) {
            if (contentRows[y] === 0) {
              if (currentGapStart === -1) currentGapStart = y;
            } else {
              if (currentGapStart !== -1) {
                const gapLength = y - currentGapStart;
                if (gapLength > maxGapLength) {
                  maxGapLength = gapLength;
                  maxGapStart = currentGapStart;
                }
                currentGapStart = -1;
              }
            }
          }
          if (currentGapStart !== -1) {
            const gapLength = searchEnd - currentGapStart + 1;
            if (gapLength > maxGapLength) {
              maxGapLength = gapLength;
              maxGapStart = currentGapStart;
            }
          }

          if (maxGapStart !== -1) {
            cutY = maxGapStart + Math.floor(maxGapLength / 2);
          } else {
            cutY = searchEnd;
          }
        } else {
          cutY = searchEnd;
        }
      }

      // Map low-res coordinates back to high-res canvas
      const hiStart = Math.floor(sys.start * scale);
      const hiEnd = Math.floor(cutY * scale);

      // Add 1% height padding for top, but for bottom only if keeping the whole system
      const topPadding = Math.floor(canvas.height * 0.01);
      const bottomPadding = (cutY === sys.end) ? Math.floor(canvas.height * 0.01) : 0;
      
      const finalStart = Math.max(0, hiStart - topPadding);
      const finalEnd = Math.min(canvas.height, hiEnd + bottomPadding);
      const cropHeight = finalEnd - finalStart;

      if (cropHeight > 0) {
        const cropCanvas = document.createElement('canvas');
        cropCanvas.width = canvas.width;
        cropCanvas.height = cropHeight;
        const cCtx = cropCanvas.getContext('2d')!;

        // Fill white background to be safe
        cCtx.fillStyle = 'white';
        cCtx.fillRect(0, 0, cropCanvas.width, cropCanvas.height);

        cCtx.drawImage(
          canvas,
          0, finalStart, canvas.width, cropHeight,
          0, 0, cropCanvas.width, cropCanvas.height
        );

        croppedImages.push({
          dataUrl: cropCanvas.toDataURL('image/jpeg', 0.85),
          width: cropCanvas.width,
          height: cropCanvas.height
        });
      }
    }
  }

  onProgress("Fertig analysiert!", 100);
  return croppedImages;
}

export const PAGE_LAYOUT = {
  A4_WIDTH_MM: 210,
  A4_HEIGHT_MM: 297,
  MARGIN_MM: 10,
  GAP_MM: 8
};

export function groupSystemsIntoPages(images: ExtractedSystem[]): ExtractedSystem[][] {
  const { A4_HEIGHT_MM, MARGIN_MM, GAP_MM, A4_WIDTH_MM } = PAGE_LAYOUT;
  const CONTENT_WIDTH_MM = A4_WIDTH_MM - 2 * MARGIN_MM;

  const pages: ExtractedSystem[][] = [[]];
  let currentY = MARGIN_MM;

  for (const img of images) {
    let scaledHeight = (img.height * CONTENT_WIDTH_MM) / img.width;

    // Safety check for very tall blocks (e.g. title pages)
    if (scaledHeight > A4_HEIGHT_MM - 2 * MARGIN_MM) {
      scaledHeight = A4_HEIGHT_MM - 2 * MARGIN_MM;
    }

    if (currentY + scaledHeight > A4_HEIGHT_MM - MARGIN_MM && currentY > MARGIN_MM) {
      pages.push([]);
      currentY = MARGIN_MM;
    }

    pages[pages.length - 1].push(img);
    currentY += scaledHeight + GAP_MM;
  }

  return pages;
}

export async function generatePdf(
  croppedImages: ExtractedSystem[],
  onProgress: (msg: string, percent: number) => void
): Promise<Blob> {
  onProgress("Erstelle neues PDF...", 10);
  
  const outPdf = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4'
  });

  const { A4_HEIGHT_MM: pageHeight, MARGIN_MM: margin, GAP_MM: gap, A4_WIDTH_MM: pageWidth } = PAGE_LAYOUT;
  const contentWidth = pageWidth - 2 * margin;

  let currentY = margin;
  let pageCount = 1;

  for (let i = 0; i < croppedImages.length; i++) {
    onProgress(`Setze System ${i + 1} von ${croppedImages.length}...`, 10 + (i / croppedImages.length) * 90);
    const img = croppedImages[i];
    const scaledHeight = (img.height * contentWidth) / img.width;

    if (currentY + scaledHeight > pageHeight - margin && currentY > margin) {
      outPdf.addPage();
      currentY = margin;
      pageCount++;
    }

    // Format aus der Data-URL erkennen (1-Bit Ausgabe kommt als PNG)
    const imgFormat = img.dataUrl.startsWith('data:image/png') ? 'PNG' : 'JPEG';
    outPdf.addImage(img.dataUrl, imgFormat, margin, currentY, contentWidth, scaledHeight, undefined, 'FAST');
    currentY += scaledHeight + gap; 
  }

  onProgress("Fertig!", 100);
  return outPdf.output('blob');
}
