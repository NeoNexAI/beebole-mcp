/**
 * Tools del MCP de Beebole. Una factoría crea un McpServer ligado a un cliente
 * Beebole (un token). En stdio el token viene del entorno; en HTTP, de la
 * cabecera por petición (multi-tenant stateless).
 *
 * Diseño: 16 tools consolidadas que cubren toda la superficie legacy (~110
 * servicios) sin saturar al agente. Las de lectura/análisis van primero; las de
 * escritura llevan annotation readOnlyHint:false y aviso de "confirmar antes".
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BeeboleClient, BeeboleError, type EntityRef } from './beebole.js';

const VERSION = '0.2.0';

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha YYYY-MM-DD');

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
function fail(err: unknown) {
  const msg =
    err instanceof BeeboleError ? err.message : `Error inesperado: ${(err as Error).message}`;
  return { content: [{ type: 'text' as const, text: msg }], isError: true };
}
/** Envuelve un handler async para no romper nunca la sesión MCP. */
function guard<T>(fn: (args: T) => Promise<unknown>) {
  return async (args: T) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(e);
    }
  };
}

/** Construye la EntityRef del cliente a partir de tipo + id. */
function refOf(type: 'company' | 'project' | 'subproject' | 'absence', id: string): EntityRef {
  return { [type]: id } as EntityRef;
}

export function buildServer(apiToken: string): McpServer {
  const server = new McpServer({ name: 'beebole-mcp', version: VERSION });
  const client = new BeeboleClient(apiToken);

  const READ = { readOnlyHint: true, openWorldHint: true } as const;
  const WRITE = { readOnlyHint: false, openWorldHint: true } as const;

  // ── 1. Catálogos ────────────────────────────────────────────────────
  server.registerTool(
    'beebole_list',
    {
      description:
        'Lista catálogos de Beebole: companies (clientes), projects, subprojects, tasks, people, absence types o custom fields. Para projects/subprojects acepta parentId (company/project) como filtro. Punto de partida para casi todo: de aquí salen los IDs que usan las demás tools.',
      inputSchema: {
        entity: z
          .enum(['company', 'project', 'subproject', 'task', 'person', 'absence', 'custom_field'])
          .describe('Catálogo a listar'),
        parentId: z
          .string()
          .optional()
          .describe('Filtro: company id (si entity=project) o project id (si entity=subproject)'),
      },
      annotations: { title: 'Listar catálogo Beebole', ...READ },
    },
    guard(({ entity, parentId }) => client.list(entity, parentId)),
  );

  // ── 2. Detalle de entidad ───────────────────────────────────────────
  server.registerTool(
    'beebole_get',
    {
      description:
        'Obtiene el detalle de una entidad por id: company, project, subproject, person, task o group.',
      inputSchema: {
        entity: z.enum(['company', 'project', 'subproject', 'person', 'task', 'group']),
        id: z.string().describe('ID de la entidad'),
      },
      annotations: { title: 'Detalle de entidad', ...READ },
    },
    guard(({ entity, id }) => client.get(entity, id)),
  );

  // ── 3. Entidades imputables ─────────────────────────────────────────
  server.registerTool(
    'beebole_get_loggable_entities',
    {
      description:
        'Navega el árbol company › project › subproject para una fecha y devuelve dónde se pueden imputar horas. Sin parent, parte de la raíz. Úsala antes de log_time para resolver el destino correcto.',
      inputSchema: {
        date: DATE.describe('Fecha del registro a imputar'),
        parentType: z.enum(['company', 'project', 'subproject']).optional(),
        parentId: z.string().optional().describe('ID del padre (requerido si parentType)'),
      },
      annotations: { title: 'Entidades imputables', ...READ },
    },
    guard(({ date, parentType, parentId }) =>
      client.getLoggableEntities(
        date,
        parentType && parentId ? refOf(parentType, parentId) : undefined,
      ),
    ),
  );

  // ── 4. Tareas imputables ────────────────────────────────────────────
  server.registerTool(
    'beebole_get_loggable_tasks',
    {
      description:
        'Lista las tareas disponibles para imputar en una entidad concreta y fecha. La tarea es obligatoria al imputar si la entidad las tiene.',
      inputSchema: {
        entityType: z.enum(['company', 'project', 'subproject']),
        entityId: z.string(),
        date: DATE,
      },
      annotations: { title: 'Tareas imputables', ...READ },
    },
    guard(({ entityType, entityId, date }) =>
      client.getLoggableTasks(date, refOf(entityType, entityId)),
    ),
  );

  // ── 5. Imputaciones de una persona ──────────────────────────────────
  server.registerTool(
    'beebole_list_time_entries',
    {
      description:
        'Lista las imputaciones de horas de UNA persona en un rango de fechas. Para análisis agregado de varias personas/proyectos usa mejor beebole_export_time.',
      inputSchema: {
        personId: z.string().describe('ID de persona (de beebole_list entity=person)'),
        from: DATE.describe('Fecha inicial (incluida)'),
        to: DATE.describe('Fecha final (incluida)'),
      },
      annotations: { title: 'Imputaciones por persona', ...READ },
    },
    guard(({ personId, from, to }) => client.listTimeEntries(personId, from, to)),
  );

  // ── 6. Export / análisis ────────────────────────────────────────────
  server.registerTool(
    'beebole_export_time',
    {
      description:
        'EXPORT de time records para análisis: rango de fechas + filtros opcionales (grupos/tags, estado de aprobación, una entidad). Lanza un job en Beebole y espera el resultado (puede tardar unos segundos). Devuelve filas con horas por persona/proyecto/tarea — la base para "horas por proyecto", desviaciones y rentabilidad.',
      inputSchema: {
        from: DATE,
        to: DATE,
        outputFormat: z
          .enum(['array', 'csv'])
          .optional()
          .describe('array (por defecto, JSON tabular) o csv'),
        statusFilters: z
          .array(z.string())
          .optional()
          .describe('Filtros de estado de aprobación (p.ej. ["l","a"] = locked/approved)'),
        gids: z.array(z.string()).optional().describe('IDs de grupos/tags para filtrar'),
        entityType: z.enum(['company', 'project', 'subproject']).optional(),
        entityId: z.string().optional().describe('Acota el export a esta entidad (con entityType)'),
      },
      annotations: { title: 'Export de horas (análisis)', ...READ },
    },
    guard(({ from, to, outputFormat, statusFilters, gids, entityType, entityId }) =>
      client.exportTime({
        from,
        to,
        outputFormat,
        statusFilters,
        gids,
        entity: entityType && entityId ? refOf(entityType, entityId) : undefined,
      }),
    ),
  );

  // ── 7. Alta de horas (WRITE) ────────────────────────────────────────
  server.registerTool(
    'beebole_log_time',
    {
      description:
        'Registra horas (ESCRITURA — confirma con el usuario antes de ejecutar). hours en DECIMAL (1.5 = 1h30). El destino es una sola entidad: company, project, subproject o absence. Si la entidad tiene tareas, taskId es obligatorio (usa beebole_get_loggable_tasks).',
      inputSchema: {
        targetType: z.enum(['company', 'project', 'subproject', 'absence']),
        targetId: z.string().describe('ID de la entidad destino'),
        date: DATE,
        hours: z.number().positive().describe('Horas en decimal (1.5 = 1h30)'),
        taskId: z.string().optional().describe('ID de tarea (obligatorio si la entidad tiene tareas)'),
        comment: z.string().optional(),
        xid: z.string().optional().describe('ID externo para idempotencia/mapeo'),
      },
      annotations: { title: 'Registrar horas', ...WRITE },
    },
    guard(({ targetType, targetId, date, hours, taskId, comment, xid }) =>
      client.createTimeEntry({ entity: refOf(targetType, targetId), date, hours, taskId, comment, xid }),
    ),
  );

  // ── 8. Editar horas (WRITE) ─────────────────────────────────────────
  server.registerTool(
    'beebole_update_time_entry',
    {
      description:
        'Modifica una imputación existente (ESCRITURA). Requiere id + date de la imputación. Solo cambia los campos que envíes.',
      inputSchema: {
        id: z.string(),
        date: DATE.describe('Fecha actual de la imputación'),
        targetType: z.enum(['company', 'project', 'subproject', 'absence']).optional(),
        targetId: z.string().optional(),
        hours: z.number().positive().optional(),
        taskId: z.string().optional(),
        comment: z.string().optional(),
      },
      annotations: { title: 'Editar imputación', ...WRITE, idempotentHint: true },
    },
    guard(({ id, date, targetType, targetId, hours, taskId, comment }) =>
      client.updateTimeEntry({
        id,
        date,
        entity: targetType && targetId ? refOf(targetType, targetId) : undefined,
        hours,
        taskId,
        comment,
      }),
    ),
  );

  // ── 9. Borrar horas (WRITE / destructivo) ───────────────────────────
  server.registerTool(
    'beebole_delete_time_entry',
    {
      description:
        'Borra una imputación por id + date (ESCRITURA DESTRUCTIVA — pide confirmación explícita). No se puede deshacer.',
      inputSchema: { id: z.string(), date: DATE },
      annotations: { title: 'Borrar imputación', ...WRITE, destructiveHint: true },
    },
    guard(({ id, date }) => client.deleteTimeEntry(id, date)),
  );

  // ── 10. Timesheets: aprobación / bloqueo (WRITE) ────────────────────
  server.registerTool(
    'beebole_timesheet',
    {
      description:
        'Acciones de workflow sobre el timesheet de una persona (ESCRITURA): submit (enviar a aprobación), approve, reject (requiere memo, se notifica al empleado), lock, unlock. Por rango (from+to) o por imputación concreta (entryId+date).',
      inputSchema: {
        action: z.enum(['submit', 'approve', 'reject', 'lock', 'unlock']),
        personId: z.string(),
        from: DATE.optional(),
        to: DATE.optional(),
        entryId: z.string().optional(),
        date: DATE.optional(),
        memo: z.string().optional().describe('Motivo (obligatorio en reject)'),
      },
      annotations: { title: 'Aprobación de timesheet', ...WRITE },
    },
    guard((a) => client.timesheetAction(a)),
  );

  // ── 11. Gestión de catálogo (WRITE) ─────────────────────────────────
  server.registerTool(
    'beebole_manage_entity',
    {
      description:
        'CRUD de catálogo (ESCRITURA): crea, actualiza, activa o desactiva company, project, subproject, task o person. "fields" es un objeto con los atributos (p.ej. {name, company:{id}} al crear un project; {name, company:{id}, email, invite, userGroup} al crear una person). Para activate/deactivate basta id.',
      inputSchema: {
        entity: z.enum(['company', 'project', 'subproject', 'task', 'person']),
        action: z.enum(['create', 'update', 'activate', 'deactivate']),
        id: z.string().optional().describe('ID (requerido en update/activate/deactivate)'),
        fields: z
          .record(z.string(), z.any())
          .optional()
          .describe('Atributos del recurso para create/update'),
      },
      annotations: { title: 'Gestionar catálogo', ...WRITE },
    },
    guard(({ entity, action, id, fields }) => client.manage(entity, action, { id, fields })),
  );

  // ── 12. Miembros y managers (WRITE) ─────────────────────────────────
  server.registerTool(
    'beebole_manage_membership',
    {
      description:
        'Asigna/quita personas o grupos a una company/project/subproject; en project también managers (ESCRITURA). Indica personId O groupId.',
      inputSchema: {
        op: z.enum(['attach_member', 'detach_member', 'attach_manager', 'detach_manager']),
        scope: z.enum(['company', 'project', 'subproject']),
        scopeId: z.string(),
        personId: z.string().optional(),
        groupId: z.string().optional(),
      },
      annotations: { title: 'Miembros y managers', ...WRITE },
    },
    guard((a) => client.membership(a)),
  );

  // ── 13. Árbol de grupos/tags ────────────────────────────────────────
  server.registerTool(
    'beebole_group_tree',
    {
      description:
        'Devuelve el árbol jerárquico completo de grupos/tags de la cuenta (para filtrar exports por gids o para etiquetar entidades).',
      inputSchema: {},
      annotations: { title: 'Árbol de grupos', ...READ },
    },
    guard(() => client.groupTree()),
  );

  // ── 14. Gestión de grupos (WRITE) ───────────────────────────────────
  server.registerTool(
    'beebole_manage_group',
    {
      description:
        'Crea, renombra/mueve o elimina un grupo/tag (ESCRITURA). En create/update: name y opcional parentId. En delete: id.',
      inputSchema: {
        action: z.enum(['create', 'update', 'delete']),
        id: z.string().optional(),
        name: z.string().optional(),
        parentId: z.string().optional(),
      },
      annotations: { title: 'Gestionar grupo', ...WRITE },
    },
    guard(({ action, id, name, parentId }) => client.manageGroup(action, { id, name, parentId })),
  );

  // ── 15. Etiquetar entidad (WRITE) ───────────────────────────────────
  server.registerTool(
    'beebole_tag_entity',
    {
      description:
        'Añade o quita una entidad (company/project/subproject/task/person/absence) de un grupo/tag (ESCRITURA).',
      inputSchema: {
        op: z.enum(['add_group', 'remove_group']),
        entity: z.enum(['company', 'project', 'subproject', 'task', 'person', 'absence']),
        entityId: z.string(),
        groupId: z.string(),
      },
      annotations: { title: 'Etiquetar entidad', ...WRITE },
    },
    guard((a) => client.tagEntity(a)),
  );

  // ── 16. Custom fields (READ + WRITE) ────────────────────────────────
  server.registerTool(
    'beebole_custom_field',
    {
      description:
        'Custom fields: op=list_definitions (todas las definiciones); op=get_values (valores de una entidad); op=set (fija valor); op=clear (borra valor). Para get_values/set/clear indica entity + entityId + customFieldId (y value en set).',
      inputSchema: {
        op: z.enum(['list_definitions', 'get_values', 'set', 'clear']),
        entity: z.enum(['company', 'project', 'subproject', 'person']).optional(),
        entityId: z.string().optional(),
        customFieldId: z.string().optional(),
        value: z.string().optional(),
      },
      annotations: { title: 'Custom fields', openWorldHint: true },
    },
    guard(({ op, entity, entityId, customFieldId, value }) => {
      if (op === 'list_definitions') return client.listCustomFields();
      if (!entity || !entityId) {
        throw new BeeboleError('get_values/set/clear requieren entity + entityId.');
      }
      if (op === 'get_values') return client.getCustomFieldValues(entity, entityId);
      if (!customFieldId) throw new BeeboleError('set/clear requieren customFieldId.');
      return client.setCustomFieldValue({
        entity,
        entityId,
        customFieldId,
        value: op === 'set' ? value : undefined,
      });
    }),
  );

  return server;
}
