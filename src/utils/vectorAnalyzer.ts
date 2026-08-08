import * as pdfjsLib from 'pdfjs-dist';

export async function analyzePdfVectors(
  file: File,
  onProgress: (msg: string) => void
): Promise<string> {
  try {
    onProgress("Lade PDF...");
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    
    onProgress("Lade Seite 1...");
    const page = await pdf.getPage(1);
    
    onProgress("Extrahiere Vektordaten...");
    const opList = await page.getOperatorList();
    
    // Create reverse map for OPS
    const opsNameMap: Record<number, string> = {};
    for (const [key, value] of Object.entries(pdfjsLib.OPS)) {
      opsNameMap[value as number] = key;
    }
    
    let output = `=== Vektor Analyse (Seite 1) ===\n`;
    output += `PDF Version: ${pdf.numPages} Seiten\n`;
    output += `Anzahl Befehle auf Seite 1: ${opList.fnArray.length}\n\n`;
    
    const limit = Math.min(2500, opList.fnArray.length);
    for(let i = 0; i < limit; i++) {
      const fn = opList.fnArray[i];
      const args = opList.argsArray[i];
      const opName = opsNameMap[fn] || `Unknown(${fn})`;
      
      let argsStr = '';
      if (args && args.length > 0) {
        try {
          // Format numbers to 2 decimal places to avoid visual clutter
          const formattedArgs = args.map((a: any) => {
            if (typeof a === 'number') return Number(a.toFixed(2));
            if (typeof a === 'string') return a.length > 50 ? a.substring(0, 50) + '...' : a;
            return a;
          });
          argsStr = JSON.stringify(formattedArgs);
        } catch (e) {
          argsStr = "[Complex Object]";
        }
      }
      
      output += `[${i.toString().padStart(4, ' ')}] ${opName.padEnd(15, ' ')} ${argsStr}\n`;
    }
    
    if (opList.fnArray.length > limit) {
      output += `\n... (Ausgabe nach ${limit} Befehlen abgeschnitten)`;
    }
    
    onProgress("Fertig!");
    return output;
  } catch (err: any) {
    return `Error analyzing PDF: ${err.message}`;
  }
}
