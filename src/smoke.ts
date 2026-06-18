/**
 * Smoke test del spike de verificación. Ejecuta llamadas reales contra Beebole
 * para confirmar endpoint, auth y forma de respuesta ANTES de dar por bueno el MCP.
 *
 *   BEEBOLE_API_KEY=xxxx node dist/smoke.js
 *
 * Solo lectura (no crea registros). Imprime un resumen por servicio.
 */

import { BeeboleClient } from './beebole.js';

function preview(label: string, data: unknown): void {
  const s = JSON.stringify(data);
  console.log(`\n=== ${label} ===`);
  console.log(`  bytes: ${s.length}`);
  console.log(`  preview: ${s.slice(0, 400)}${s.length > 400 ? '…' : ''}`);
}

async function main(): Promise<void> {
  const token = process.env.BEEBOLE_API_KEY ?? '';
  if (!token.trim()) {
    console.error('Falta BEEBOLE_API_KEY.');
    process.exit(1);
  }
  const c = new BeeboleClient(token);

  try {
    preview('get_entities (proyectos)', await c.listEntities());
  } catch (e) {
    console.error('get_entities FALLO:', (e as Error).message);
  }
  try {
    preview('get_tasks', await c.listTasks());
  } catch (e) {
    console.error('get_tasks FALLO:', (e as Error).message);
  }
  try {
    // Últimos ~30 días sin depender de Date.now en build: pasar por env opcional.
    const to = process.env.SMOKE_TO ?? '2026-06-18';
    const from = process.env.SMOKE_FROM ?? '2026-05-18';
    preview(`time_entry.export ${from}..${to}`, await c.exportTimeEntries({ from, to }));
  } catch (e) {
    console.error('time_entry.export FALLO:', (e as Error).message);
  }

  console.log('\n[smoke] Revisa arriba: si los 3 devuelven datos, el MCP está verificado.');
}

main();
