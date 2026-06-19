/**
 * Smoke test del spike de verificación. Ejecuta llamadas REALES de solo lectura
 * contra Beebole para confirmar endpoint, auth, nombres de servicio y forma de
 * respuesta ANTES de dar el MCP por "operativo-verificado".
 *
 *   BEEBOLE_API_KEY=xxxx node dist/smoke.js
 *
 * No crea ni modifica nada. Imprime un resumen por servicio y un veredicto.
 */

import { BeeboleClient } from './beebole.js';

let passed = 0;
let failed = 0;

function preview(label: string, data: unknown): void {
  const s = JSON.stringify(data);
  console.log(`\n=== ${label} ===`);
  console.log(`  bytes: ${s.length}`);
  console.log(`  preview: ${s.slice(0, 400)}${s.length > 400 ? '…' : ''}`);
  passed++;
}

async function probe(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    preview(label, await fn());
  } catch (e) {
    failed++;
    console.error(`\n=== ${label} === FALLO: ${(e as Error).message}`);
  }
}

async function main(): Promise<void> {
  const token = process.env.BEEBOLE_API_KEY ?? '';
  if (!token.trim()) {
    console.error('Falta BEEBOLE_API_KEY.');
    process.exit(1);
  }
  const c = new BeeboleClient(token);
  const to = process.env.SMOKE_TO ?? '2026-06-18';
  const from = process.env.SMOKE_FROM ?? '2026-05-18';

  await probe('company.list', () => c.list('company'));
  await probe('project.list', () => c.list('project'));
  await probe('person.list', () => c.list('person'));
  await probe('task.list', () => c.list('task'));
  await probe('custom_field.list', () => c.listCustomFields());
  await probe('group.tree', () => c.groupTree());
  await probe(`time_entry.get_entities (${to})`, () => c.getLoggableEntities(to));
  await probe(`time_entry.export ${from}..${to}`, () => c.exportTime({ from, to }));

  console.log(`\n[smoke] OK=${passed}  FALLO=${failed}`);
  if (failed > 0) {
    console.log('[smoke] Hay fallos: revisa los nombres de servicio / shape arriba antes de marcar verificado.');
    process.exit(2);
  }
  console.log('[smoke] Todos los servicios de lectura responden → MCP verificado.');
}

main();
