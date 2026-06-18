#!/usr/bin/env node
/**
 * Entry point del MCP de Beebole. Dos modos:
 *
 *   1) STDIO (por defecto, recomendado / local en el PC del cliente):
 *      el token vive en la variable de entorno BEEBOLE_API_KEY del propio PC.
 *      Uso:  npx @neonexai/beebole-mcp     (con BEEBOLE_API_KEY exportada)
 *
 *   2) HTTP remoto (VPS, MCP_TRANSPORT=http): stateless, multi-tenant. El token
 *      llega en la cabecera X-Beebole-Key en CADA petición y NO se almacena.
 *      Uso:  MCP_TRANSPORT=http PORT=8087 node dist/index.js
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type Request, type Response } from 'express';
import { buildServer } from './tools.js';

async function runStdio(): Promise<void> {
  const token = process.env.BEEBOLE_API_KEY ?? '';
  if (!token.trim()) {
    process.stderr.write('[beebole-mcp] Falta BEEBOLE_API_KEY en el entorno.\n');
    process.exit(1);
  }
  const server = buildServer(token);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[beebole-mcp] stdio listo.\n');
}

function runHttp(): void {
  const port = Number(process.env.PORT ?? 8087);
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Health check (sin auth) para nginx/Coolify.
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true, service: 'beebole-mcp' });
  });

  // MCP endpoint stateless: un server efímero por petición, ligado al token del header.
  app.post('/mcp', async (req: Request, res: Response) => {
    const token = (req.header('x-beebole-key') ?? '').trim();
    if (!token) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Falta la cabecera X-Beebole-Key.' },
        id: null,
      });
      return;
    }
    const server = buildServer(token);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      process.stderr.write(`[beebole-mcp] error HTTP: ${(err as Error).message}\n`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Error interno del servidor MCP.' },
          id: null,
        });
      }
    }
  });

  app.listen(port, () => {
    process.stderr.write(`[beebole-mcp] HTTP stateless escuchando en :${port} (POST /mcp)\n`);
  });
}

if ((process.env.MCP_TRANSPORT ?? '').toLowerCase() === 'http') {
  runHttp();
} else {
  runStdio().catch((err) => {
    process.stderr.write(`[beebole-mcp] fallo al iniciar: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
