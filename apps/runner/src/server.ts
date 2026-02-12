import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import { createServer } from 'node:http';
import { KeyVault } from './lib/key-vault.js';
import { RunController } from './lib/run-controller.js';
import { resolveSheetData } from './lib/sheet.js';
import {
  providerSchema,
  resolveSheetRequestSchema,
  runRequestSchema,
  saveKeyRequestSchema
} from './types.js';
import { attachRunWebsocket } from './ws/hub.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = path.resolve(__dirname, '../../..');
const artifactsRoot = path.join(projectRoot, 'artifacts');
const dataRoot = path.join(__dirname, '../.data');

const keyVault = new KeyVault(dataRoot);
const runController = new RunController(artifactsRoot);

const app = express();
const server = createServer(app);
attachRunWebsocket(server, runController);

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/artifacts', express.static(artifactsRoot));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/keys', async (_req, res) => {
  res.json({ providers: await keyVault.listMasked() });
});

app.post('/api/keys', async (req, res) => {
  const parsed = saveKeyRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  await keyVault.setKey(parsed.data.provider, parsed.data.apiKey);
  return res.status(201).json({ ok: true });
});

app.delete('/api/keys/:provider', async (req, res) => {
  const parsed = providerSchema.safeParse(req.params.provider);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid provider.' });
  }

  await keyVault.deleteKey(parsed.data);
  return res.status(204).send();
});

app.post('/api/sheet/resolve', async (req, res) => {
  const parsed = resolveSheetRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const data = await resolveSheetData({
      ...(parsed.data.sheetUrl ? { sheetUrl: parsed.data.sheetUrl } : {}),
      ...(parsed.data.csvContent ? { csvContent: parsed.data.csvContent } : {})
    });
    return res.json({ data, count: Object.keys(data).length });
  } catch (error) {
    return res.status(400).json({
      error: error instanceof Error ? error.message : 'Unable to resolve sheet data.'
    });
  }
});

app.post('/api/runs', async (req, res) => {
  const parsed = runRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const payload = parsed.data;
  const apiKey = payload.apiKey ?? (await keyVault.getKey(payload.provider));

  if (!apiKey) {
    return res.status(400).json({ error: `No API key provided/stored for ${payload.provider}.` });
  }

  const run = await runController.startRun({ ...payload, apiKey });
  return res.status(202).json({ runId: run.runId, status: run.status });
});

app.get('/api/runs', (_req, res) => {
  res.json({ runs: runController.listRuns() });
});

app.get('/api/runs/:runId', (req, res) => {
  const run = runController.getRun(req.params.runId);
  if (!run) {
    return res.status(404).json({ error: 'Run not found.' });
  }

  return res.json(run);
});

const uiDist = path.join(projectRoot, 'apps/ui/dist');
app.use(express.static(uiDist));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/artifacts') || req.path.startsWith('/ws')) {
    return next();
  }
  return res.sendFile(path.join(uiDist, 'index.html'));
});

const port = Number(process.env.PORT ?? 8787);
server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Verdant runner listening on http://localhost:${port}`);
});
