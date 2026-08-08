import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, type Plugin} from 'vite';
import {writeFileSync, mkdirSync, appendFileSync} from 'node:fs';

// Dev-Server-Ablage für den Direkt-Download: die App POSTet das generierte
// PDF hierher; ein GET liefert es mit Attachment-Header aus (neuer Tab
// speichert dann automatisch ins Download-Verzeichnis).
const exportStore: { data: Buffer | null; name: string } = { data: null, name: 'geschnitten.pdf' };

const exportStorePlugin = (): Plugin => ({
  name: 'export-store',
  configureServer(server) {
    // Upload von Testdateien aus dem Browser (Debugging-Kanal, nur Dev)
    server.middlewares.use('/api/upload', (req, res) => {
      if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
      const url = new URL(req.url ?? '', 'http://localhost');
      const rawName = url.searchParams.get('name') ?? 'upload.bin';
      const name = rawName.replace(/[^A-Za-z0-9._-]/g, '_');
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const dir = '/home/user/uploads';
        mkdirSync(dir, { recursive: true });
        writeFileSync(`${dir}/${name}`, Buffer.concat(chunks));
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, saved: `${dir}/${name}` }));
      });
    });

    // Diagnosepakete aus App 2 direkt im Repository sichern. Dadurch kann der
    // Agent die Resultate lokal öffnen, bewerten, iterieren und bei Bedarf den
    // Ordner nach GitHub pushen. Nur Dev-Server; im statischen Build ignoriert.
    server.middlewares.use('/api/scan-capture', (req, res) => {
      if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
      const url = new URL(req.url ?? '', 'http://localhost');
      const safe = (v: string) => v.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 140);
      const session = safe(url.searchParams.get('session') ?? new Date().toISOString().replace(/[:.]/g, '-'));
      const name = safe(url.searchParams.get('name') ?? 'artifact.bin');
      const dir = path.resolve(__dirname, 'debug_scan', session);
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        mkdirSync(dir, { recursive: true });
        const data = Buffer.concat(chunks);
        const filePath = path.join(dir, name);
        writeFileSync(filePath, data);
        appendFileSync(path.join(dir, 'manifest.txt'), `${new Date().toISOString()}  ${name}  ${data.length} bytes\n`);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, saved: path.relative(__dirname, filePath), dir: path.relative(__dirname, dir), bytes: data.length }));
      });
    });

    server.middlewares.use('/api/export.pdf', (req, res) => {
      if (!exportStore.data) { res.statusCode = 404; res.end('Noch kein Export erstellt.'); return; }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${exportStore.name}"`);
      res.end(exportStore.data);
    });
    server.middlewares.use('/api/export', (req, res) => {
      if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
      const url = new URL(req.url ?? '', 'http://localhost');
      const name = url.searchParams.get('name');
      if (name) exportStore.name = name;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        exportStore.data = Buffer.concat(chunks);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, bytes: exportStore.data.length }));
      });
    });
  },
});

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), exportStorePlugin()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      // Allow the Arena/E2B live-preview hosts to reach the dev server.
      allowedHosts: ['.e2b.app'],
    },
  };
});
