/**
 * Definición de las tools del MCP de Beebole. Una factoría crea un McpServer
 * ligado a un cliente Beebole (un token). En stdio el token viene del entorno;
 * en HTTP, de la cabecera por petición (multi-tenant stateless).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BeeboleClient, BeeboleError } from './beebole.js';

const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha YYYY-MM-DD');

/** Envuelve un handler para devolver errores como texto (no romper la sesión MCP). */
function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
function fail(err: unknown) {
  const msg = err instanceof BeeboleError ? err.message : `Error inesperado: ${(err as Error).message}`;
  return { content: [{ type: 'text' as const, text: msg }], isError: true };
}

export function buildServer(apiToken: string): McpServer {
  const server = new McpServer({ name: 'beebole-mcp', version: '0.1.0' });
  const client = new BeeboleClient(apiToken);

  server.tool(
    'beebole_list_projects',
    'Lista la jerarquía de empresa, proyectos y subproyectos del usuario en Beebole.',
    {},
    async () => {
      try {
        return ok(await client.listEntities());
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    'beebole_list_tasks',
    'Lista el catálogo de tareas disponibles en Beebole.',
    {},
    async () => {
      try {
        return ok(await client.listTasks());
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    'beebole_get_time_entries',
    'Devuelve los registros de horas entre dos fechas (YYYY-MM-DD). Útil para análisis de horas por proyecto y desviaciones.',
    {
      from: DATE.describe('Fecha inicial (incluida), YYYY-MM-DD'),
      to: DATE.describe('Fecha final (incluida), YYYY-MM-DD'),
    },
    async ({ from, to }) => {
      try {
        return ok(await client.exportTimeEntries({ from, to }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    'beebole_log_time',
    'Registra horas en un proyecto. duration en MINUTOS. Pide confirmación al usuario antes de usarla (es una escritura).',
    {
      projectId: z.string().describe('ID del proyecto en Beebole (de beebole_list_projects)'),
      date: DATE.describe('Fecha del registro, YYYY-MM-DD'),
      durationMinutes: z.number().int().positive().describe('Duración en minutos'),
      taskId: z.string().optional().describe('ID de tarea (opcional)'),
      comment: z.string().optional().describe('Comentario (opcional)'),
    },
    async ({ projectId, date, durationMinutes, taskId, comment }) => {
      try {
        return ok(await client.createTimeEntry({ projectId, date, durationMinutes, taskId, comment }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}
