/**
 * Tools del MCP de Beebole sobre la API GraphQL nueva (app.beebole.com/graphql).
 *
 * Arquitectura HÍBRIDA (la API tiene 87 queries + 745 mutations → inviable 1:1):
 *   A) ~24 tools CURADAS para el flujo real de un estudio (Cota Zero): identidad,
 *      proyectos/tareas/personas, fichaje de horas (alta/edición/borrado),
 *      timesheets (enviar/aprobar/rechazar), tags, ausencias e informes.
 *   B) 3 tools GENÉRICAS para cobertura del 100%:
 *      - beebole_search_schema       descubre cualquier operación por palabra clave
 *      - beebole_describe_operation  da su firma completa (args + inputs + retorno)
 *      - beebole_graphql             ejecuta cualquier query/mutation cruda
 *
 * Con A+B el agente resuelve el 80% con tools claras y el 20% restante (las ~800
 * operaciones de administración/config) vía descubrir → describir → ejecutar.
 *
 * Factoría: buildServer(apiKey) → McpServer ligado a un cliente (un token). En
 * stdio el token viene del entorno; en HTTP, de la cabecera por petición.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BeeboleClient, BeeboleError, selection, searchOps, describeOp, gqlArgs } from './client.js';

const VERSION = '1.0.0';

// Selecciones reutilizables (compactas para listas, ricas para "get").
const SEL_PROJECT = () => selection('BeeboleProject', 0);
const SEL_TASK = () => selection('BeeboleTask', 0);
const SEL_PERSON = () => selection('BeebolePerson', 0);
const SEL_TR = () => selection('BeeboleTimeRecord', 1);
const SEL_TAG = () => selection('BeeboleTag', 0);
const SEL_ABS = () => selection('BeeboleAbsenceType', 0);
const SEL_REPORT = () => selection('BeeboleReport', 0);
const SEL_EVENT = () => selection('BeeboleApprovalEvent', 0);

type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  const json = JSON.stringify(data, null, 2);
  const text = json.length > 100_000 ? json.slice(0, 100_000) + '\n…(truncado)…' : json;
  return {
    content: [{ type: 'text', text }],
    structuredContent: data && typeof data === 'object' ? (data as Record<string, unknown>) : { value: data },
  };
}

function fail(err: unknown): ToolResult {
  const msg = err instanceof BeeboleError ? err.message : `Error inesperado: ${(err as Error).message}`;
  return { content: [{ type: 'text', text: `❌ ${msg}` }], isError: true };
}

/** Envuelve un handler async con try/catch → ToolResult de error accionable. */
function guard<A>(fn: (args: A) => Promise<ToolResult>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      return fail(err);
    }
  };
}

const TS = z.number().int().describe('Unix timestamp en MILISEGUNDOS (epoch ms, > 1e10). Ej: 1750000000000.');
const ID = z.string().describe('BeeboleId (ObjectId, 24 hex).');

export function buildServer(apiKey: string): McpServer {
  const beebole = new BeeboleClient(apiKey);
  const server = new McpServer({ name: 'beebole-mcp', version: VERSION });
  const RO = { readOnlyHint: true, openWorldHint: true } as const;
  const WR = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
  const DESTR = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;

  // ── A) Identidad / contexto ────────────────────────────────────────────────

  server.registerTool(
    'beebole_whoami',
    {
      title: 'Quién soy + organización',
      description:
        'Devuelve la persona autenticada por la API key (id, nombre, email, rol) y su organización. Empieza por aquí para conocer tu propio personId y el contexto de la cuenta.',
      inputSchema: {},
      annotations: RO,
    },
    guard(async () => {
      const q = `query{ currentPerson{ ${selection('BeebolePerson', 1)} } currentOrganisation{ ${selection(
        'BeeboleOrganisation',
        0,
      )} } }`;
      return ok(await beebole.graphql(q));
    }),
  );

  // ── A) Lecturas: proyectos / tareas / personas ─────────────────────────────

  server.registerTool(
    'beebole_list_projects',
    {
      title: 'Listar proyectos',
      description:
        'Lista proyectos con filtros opcionales. Sin filtros devuelve los proyectos de nivel raíz activos.',
      inputSchema: {
        archived: z.boolean().optional().describe('Incluir/solo archivados.'),
        name: z.string().optional().describe('Filtra por nombre (substring).'),
        categoryId: ID.optional(),
        tagIds: z.array(z.string()).optional().describe('Solo proyectos con estos tags.'),
        assignedPersonId: ID.optional(),
        managedById: ID.optional(),
      },
      annotations: RO,
    },
    guard(async (a) => {
      const filter: Record<string, unknown> = {};
      if (a.name !== undefined) filter.name = a.name;
      if (a.tagIds !== undefined) filter.tagIds = a.tagIds;
      if (a.assignedPersonId !== undefined) filter.assignedPersonId = a.assignedPersonId;
      if (a.managedById !== undefined) filter.managedById = a.managedById;
      const { decls, args, variables } = gqlArgs([
        { name: 'filter', type: '[BeeboleProjectFilter]', value: Object.keys(filter).length ? [filter] : undefined },
        { name: 'archived', type: 'Boolean', value: a.archived },
        { name: 'categoryId', type: 'BeeboleId', value: a.categoryId },
      ]);
      const q = `query${decls}{ getProjects${args}{ ${SEL_PROJECT()} } }`;
      const d = await beebole.graphql<{ getProjects: unknown[] }>(q, variables);
      return ok(d.getProjects);
    }),
  );

  server.registerTool(
    'beebole_get_project',
    {
      title: 'Detalle de un proyecto',
      description: 'Devuelve un proyecto por id con detalle (categoría, padre, managers, budgets).',
      inputSchema: { id: ID },
      annotations: RO,
    },
    guard(async (a) => {
      const q = `query($id:BeeboleId!){ getProject(id:$id){ ${selection('BeeboleProject', 1)} } }`;
      return ok((await beebole.graphql<{ getProject: unknown }>(q, { id: a.id })).getProject);
    }),
  );

  server.registerTool(
    'beebole_list_tasks',
    {
      title: 'Listar tareas',
      description: 'Lista tareas con filtros (proyecto, estado, responsable, persona asignada, categoría, rango).',
      inputSchema: {
        projectId: ID.optional(),
        statusId: ID.optional(),
        ownerId: ID.optional(),
        assignedPersonId: ID.optional(),
        name: z.string().optional(),
        archived: z.boolean().optional(),
        categoryId: ID.optional(),
        startTime: TS.optional(),
        endTime: TS.optional(),
      },
      annotations: RO,
    },
    guard(async (a) => {
      const filter: Record<string, unknown> = {};
      for (const k of ['projectId', 'statusId', 'ownerId', 'assignedPersonId', 'name'] as const)
        if (a[k] !== undefined) filter[k] = a[k];
      const { decls, args, variables } = gqlArgs([
        { name: 'filter', type: '[BeeboleTaskFilter]', value: Object.keys(filter).length ? [filter] : undefined },
        { name: 'archived', type: 'Boolean', value: a.archived },
        { name: 'categoryId', type: 'BeeboleId', value: a.categoryId },
        { name: 'startTime', type: 'BeeboleTimestamp', value: a.startTime },
        { name: 'endTime', type: 'BeeboleTimestamp', value: a.endTime },
      ]);
      const q = `query${decls}{ getTasks${args}{ ${SEL_TASK()} } }`;
      return ok((await beebole.graphql<{ getTasks: unknown[] }>(q, variables)).getTasks);
    }),
  );

  server.registerTool(
    'beebole_get_task',
    {
      title: 'Detalle de una tarea',
      description: 'Devuelve una tarea por id con detalle.',
      inputSchema: { id: ID },
      annotations: RO,
    },
    guard(async (a) => {
      const q = `query($id:BeeboleId!){ getTask(id:$id){ ${selection('BeeboleTask', 1)} } }`;
      return ok((await beebole.graphql<{ getTask: unknown }>(q, { id: a.id })).getTask);
    }),
  );

  server.registerTool(
    'beebole_list_persons',
    {
      title: 'Listar personas',
      description: 'Lista las personas (usuarios) de la organización, con filtros opcionales.',
      inputSchema: {
        archived: z.boolean().optional(),
        roleId: ID.optional(),
        name: z.string().optional(),
        tagIds: z.array(z.string()).optional(),
      },
      annotations: RO,
    },
    guard(async (a) => {
      const filter: Record<string, unknown> = {};
      if (a.roleId !== undefined) filter.roleId = a.roleId;
      if (a.name !== undefined) filter.name = a.name;
      if (a.tagIds !== undefined) filter.tagIds = a.tagIds;
      const { decls, args, variables } = gqlArgs([
        { name: 'filter', type: '[BeebolePersonFilter]', value: Object.keys(filter).length ? [filter] : undefined },
        { name: 'archived', type: 'Boolean', value: a.archived },
      ]);
      const q = `query${decls}{ getPersons${args}{ ${SEL_PERSON()} } }`;
      return ok((await beebole.graphql<{ getPersons: unknown[] }>(q, variables)).getPersons);
    }),
  );

  server.registerTool(
    'beebole_get_person',
    {
      title: 'Detalle de una persona',
      description: 'Devuelve una persona por id con detalle (rol, organización, ajustes).',
      inputSchema: { id: ID },
      annotations: RO,
    },
    guard(async (a) => {
      const q = `query($id:BeeboleId!){ getPerson(id:$id){ ${selection('BeebolePerson', 1)} } }`;
      return ok((await beebole.graphql<{ getPerson: unknown }>(q, { id: a.id })).getPerson);
    }),
  );

  // ── A) Time records (fichaje de horas — el núcleo) ─────────────────────────

  const trFilterSchema = {
    startTime: TS.optional().describe('Inicio del rango (epoch ms).'),
    endTime: TS.optional().describe('Fin del rango (epoch ms).'),
    personId: ID.optional(),
    personIds: z.array(z.string()).optional(),
    projectIds: z.array(z.string()).optional(),
    taskIds: z.array(z.string()).optional(),
    status: z.enum(['d', 's', 'a', 'r']).optional().describe('d=draft, s=submitted, a=approved, r=rejected.'),
    onlyTime: z.boolean().optional().describe('Solo imputaciones de tiempo (no ausencias).'),
    onlyAbsence: z.boolean().optional().describe('Solo ausencias.'),
    wfh: z.boolean().optional().describe('Solo teletrabajo.'),
  };

  function trArgs(a: Record<string, unknown>) {
    const filter: Record<string, unknown> = {};
    for (const k of ['personId', 'personIds', 'projectIds', 'taskIds', 'status'] as const)
      if (a[k] !== undefined) filter[k] = a[k];
    return gqlArgs([
      { name: 'startTime', type: 'BeeboleTimestamp', value: a.startTime },
      { name: 'endTime', type: 'BeeboleTimestamp', value: a.endTime },
      { name: 'time', type: 'Boolean', value: a.onlyTime },
      { name: 'absence', type: 'Boolean', value: a.onlyAbsence },
      { name: 'wfh', type: 'Boolean', value: a.wfh },
      { name: 'filter', type: '[BeeboleTimeRecordFilter]', value: Object.keys(filter).length ? [filter] : undefined },
    ]);
  }

  server.registerTool(
    'beebole_list_time_records',
    {
      title: 'Listar imputaciones de horas',
      description:
        'Lista los time records (horas/ausencias fichadas) en un rango con filtros por persona, proyecto, tarea o estado. Pasa startTime/endTime (epoch ms) para acotar.',
      inputSchema: trFilterSchema,
      annotations: RO,
    },
    guard(async (a) => {
      const { decls, args, variables } = trArgs(a);
      const q = `query${decls}{ getTimeRecords${args}{ ${SEL_TR()} } }`;
      return ok((await beebole.graphql<{ getTimeRecords: unknown[] }>(q, variables)).getTimeRecords);
    }),
  );

  server.registerTool(
    'beebole_count_time_records',
    {
      title: 'Contar imputaciones',
      description: 'Cuenta los time records que casan el filtro (útil antes de listar rangos grandes).',
      inputSchema: trFilterSchema,
      annotations: RO,
    },
    guard(async (a) => {
      const { decls, args, variables } = trArgs(a);
      const q = `query${decls}{ countTimeRecords${args} }`;
      return ok(await beebole.graphql(q, variables));
    }),
  );

  server.registerTool(
    'beebole_add_time_record',
    {
      title: 'Fichar horas (crear imputación)',
      description:
        'Crea una imputación de horas para una persona. duration en MINUTOS. startTime en epoch ms. Indica taskId (y opcionalmente projectIds) para tiempo, o absenceId para una ausencia. comment/nonBillable/wfh se aplican tras crear.',
      inputSchema: {
        personId: ID,
        startTime: TS.describe('Inicio (epoch ms). Para fichaje por día, usa el inicio del día.'),
        durationMinutes: z.number().int().positive().describe('Duración en minutos (ej. 90 = 1h30).'),
        endTime: TS.optional(),
        taskId: ID.optional(),
        projectIds: z.array(z.string()).optional(),
        absenceId: ID.optional().describe('Para fichar una ausencia en lugar de tiempo.'),
        comment: z.string().optional(),
        nonBillable: z.boolean().optional(),
        wfh: z.boolean().optional(),
      },
      annotations: WR,
    },
    guard(async (a) => {
      const { decls, args, variables } = gqlArgs([
        { name: 'startTime', type: 'BeeboleTimestamp!', value: a.startTime },
        { name: 'endTime', type: 'BeeboleTimestamp', value: a.endTime },
        { name: 'duration', type: 'Int!', value: a.durationMinutes },
        { name: 'personId', type: 'BeeboleId!', value: a.personId },
        { name: 'taskId', type: 'BeeboleId', value: a.taskId },
        { name: 'absenceId', type: 'BeeboleId', value: a.absenceId },
        { name: 'projectIds', type: '[BeeboleId]', value: a.projectIds },
      ]);
      const q = `mutation${decls}{ addTimeRecord${args}{ id } }`;
      const created = (await beebole.graphql<{ addTimeRecord: { id: string } }>(q, variables)).addTimeRecord;
      const id = created.id;
      // Campos no soportados por addTimeRecord → se aplican con edits puntuales.
      const edits = await applyTimeRecordEdits(beebole, id, {
        comment: a.comment,
        nonBillable: a.nonBillable,
        wfh: a.wfh,
      });
      if (edits) return ok(edits);
      const got = `query($id:BeeboleId!){ getTimeRecord(id:$id){ ${SEL_TR()} } }`;
      return ok((await beebole.graphql<{ getTimeRecord: unknown }>(got, { id })).getTimeRecord);
    }),
  );

  server.registerTool(
    'beebole_edit_time_record',
    {
      title: 'Editar una imputación',
      description:
        'Modifica campos de un time record existente. Pasa solo los que quieras cambiar: comment, durationMinutes, startTime, endTime, taskId, projectIds, nonBillable, wfh.',
      inputSchema: {
        id: ID,
        comment: z.string().optional(),
        durationMinutes: z.number().int().positive().optional(),
        startTime: TS.optional(),
        endTime: TS.optional(),
        taskId: ID.optional(),
        projectIds: z.array(z.string()).optional(),
        nonBillable: z.boolean().optional(),
        wfh: z.boolean().optional(),
      },
      annotations: WR,
    },
    guard(async (a) => {
      const result = await applyTimeRecordEdits(beebole, a.id, a);
      if (!result) throw new BeeboleError('No indicaste ningún campo que cambiar.');
      return ok(result);
    }),
  );

  server.registerTool(
    'beebole_delete_time_records',
    {
      title: 'Borrar imputaciones',
      description: 'Elimina uno o varios time records por id. Acción destructiva e irreversible.',
      inputSchema: { ids: z.array(z.string()).min(1) },
      annotations: DESTR,
    },
    guard(async (a) => {
      const q = `mutation($ids:[BeeboleId!]!){ deleteTimeRecords(ids:$ids){ id } }`;
      return ok(await beebole.graphql(q, { ids: a.ids }));
    }),
  );

  server.registerTool(
    'beebole_clone_time_records',
    {
      title: 'Clonar imputaciones a otro periodo',
      description: 'Copia los time records de una persona de un periodo origen a uno destino (epoch ms).',
      inputSchema: {
        personId: ID,
        sourceStartTime: TS,
        sourceEndTime: TS,
        targetStartTime: TS,
        targetEndTime: TS,
        replaceExisting: z.boolean().optional(),
      },
      annotations: WR,
    },
    guard(async (a) => {
      const q = `mutation($personId:BeeboleId!,$ss:BeeboleTimestamp!,$se:BeeboleTimestamp!,$ts:BeeboleTimestamp!,$te:BeeboleTimestamp!,$r:Boolean){ cloneTimeRecords(personId:$personId,sourceStartTime:$ss,sourceEndTime:$se,targetStartTime:$ts,targetEndTime:$te,replaceExisting:$r){ id } }`;
      return ok(
        await beebole.graphql(q, {
          personId: a.personId,
          ss: a.sourceStartTime,
          se: a.sourceEndTime,
          ts: a.targetStartTime,
          te: a.targetEndTime,
          r: a.replaceExisting,
        }),
      );
    }),
  );

  // ── A) Timesheets (workflow de aprobación) ─────────────────────────────────

  server.registerTool(
    'beebole_submit_timesheet',
    {
      title: 'Enviar timesheet a aprobación',
      description: 'Envía el timesheet de una persona para un periodo (epoch ms) al flujo de aprobación.',
      inputSchema: { personId: ID, startTime: TS, endTime: TS },
      annotations: WR,
    },
    guard(async (a) => {
      const q = `mutation($personId:BeeboleId!,$s:BeeboleTimestamp!,$e:BeeboleTimestamp!){ submitTimesheet(personId:$personId,startTime:$s,endTime:$e){ ${SEL_EVENT()} } }`;
      return ok(await beebole.graphql(q, { personId: a.personId, s: a.startTime, e: a.endTime }));
    }),
  );

  server.registerTool(
    'beebole_approve_timesheet',
    {
      title: 'Aprobar timesheet',
      description: 'Aprueba un evento de aprobación de timesheet por su id (lo da getPendingApprovals / submit).',
      inputSchema: { id: ID.describe('id del approval event.') },
      annotations: WR,
    },
    guard(async (a) => {
      const q = `mutation($id:BeeboleId!){ approveTimesheet(id:$id){ ${SEL_EVENT()} } }`;
      return ok(await beebole.graphql(q, { id: a.id }));
    }),
  );

  server.registerTool(
    'beebole_reject_timesheet',
    {
      title: 'Rechazar timesheet',
      description: 'Rechaza un timesheet en una etapa concreta con un comentario obligatorio.',
      inputSchema: { id: ID, stage: z.number().int(), comment: z.string().min(1) },
      annotations: DESTR,
    },
    guard(async (a) => {
      const q = `mutation($id:BeeboleId!,$stage:Int!,$comment:String!){ rejectTimesheet(id:$id,stage:$stage,comment:$comment){ ${SEL_EVENT()} } }`;
      return ok(await beebole.graphql(q, { id: a.id, stage: a.stage, comment: a.comment }));
    }),
  );

  // ── A) Catálogos: tags, ausencias ──────────────────────────────────────────

  server.registerTool(
    'beebole_list_tags',
    {
      title: 'Listar tags/grupos',
      description: 'Lista los tags (grupos jerárquicos) usados para clasificar personas/proyectos/tareas.',
      inputSchema: { archived: z.boolean().optional(), name: z.string().optional(), categoryId: ID.optional() },
      annotations: RO,
    },
    guard(async (a) => {
      const filter: Record<string, unknown> = {};
      if (a.name !== undefined) filter.name = a.name;
      const { decls, args, variables } = gqlArgs([
        { name: 'filter', type: '[BeeboleTagFilter]', value: Object.keys(filter).length ? [filter] : undefined },
        { name: 'archived', type: 'Boolean', value: a.archived },
        { name: 'categoryId', type: 'BeeboleId', value: a.categoryId },
      ]);
      const q = `query${decls}{ getTags${args}{ ${SEL_TAG()} } }`;
      return ok((await beebole.graphql<{ getTags: unknown[] }>(q, variables)).getTags);
    }),
  );

  server.registerTool(
    'beebole_list_absence_types',
    {
      title: 'Listar tipos de ausencia',
      description: 'Lista los tipos de ausencia (vacaciones, baja, etc.) con su unidad (día/hora).',
      inputSchema: { archived: z.boolean().optional() },
      annotations: RO,
    },
    guard(async (a) => {
      const { decls, args, variables } = gqlArgs([{ name: 'archived', type: 'Boolean', value: a.archived }]);
      const q = `query${decls}{ getAbsenceTypes${args}{ ${SEL_ABS()} } }`;
      return ok((await beebole.graphql<{ getAbsenceTypes: unknown[] }>(q, variables)).getAbsenceTypes);
    }),
  );

  // ── A) Informes ────────────────────────────────────────────────────────────

  server.registerTool(
    'beebole_list_reports',
    {
      title: 'Listar informes guardados',
      description: 'Lista los informes definidos en la cuenta (para ejecutarlos con beebole_run_report).',
      inputSchema: {},
      annotations: RO,
    },
    guard(async () => {
      const q = `query{ getReports{ ${SEL_REPORT()} } }`;
      return ok((await beebole.graphql<{ getReports: unknown[] }>(q)).getReports);
    }),
  );

  server.registerTool(
    'beebole_run_report',
    {
      title: 'Ejecutar un informe guardado',
      description:
        'Ejecuta un informe guardado por id y devuelve sus filas. Hace polling si el informe es asíncrono (campo pending). period/filters son opcionales para sobrescribir el rango.',
      inputSchema: {
        id: ID,
        period: z
          .object({
            target: z.enum(['current', 'previous', 'next', 'yearToDay', 'last12Months', 'custom']),
            period: z.enum(['day', 'week', 'biWeekly', 'semiMonth', 'month', 'quarter', 'year']).optional(),
            start: TS.optional(),
            end: TS.optional(),
          })
          .optional()
          .describe('Periodo a aplicar; con target="custom" usa start/end (epoch ms).'),
        filters: z.array(z.record(z.string(), z.unknown())).optional().describe('Array de BeeboleReportFilter.'),
      },
      annotations: RO,
    },
    guard(async (a) => {
      const { decls, args, variables } = gqlArgs([
        { name: 'id', type: 'BeeboleId!', value: a.id },
        { name: 'period', type: 'BeeboleReportParamPeriodInput', value: a.period },
        { name: 'filters', type: '[BeeboleReportFilter]', value: a.filters },
      ]);
      const runQ = `query${decls}{ x:runReport${args}{ ${selection('BeeboleReportResult', 1)} } }`;
      let result = (await beebole.graphql<{ x: { id: string; pending: boolean } }>(runQ, variables)).x;
      for (let i = 0; result?.pending && i < 20; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const pq = `query($id:BeeboleId!){ getReportResult(id:$id){ ${selection('BeeboleReportResult', 1)} } }`;
        result = (
          await beebole.graphql<{ getReportResult: { id: string; pending: boolean } }>(pq, { id: result.id })
        ).getReportResult;
      }
      return ok(result);
    }),
  );

  server.registerTool(
    'beebole_planned_vs_real',
    {
      title: 'Informe planificado vs real',
      description:
        'Compara horas planificadas vs reales en un rango (epoch ms). Útil para seguimiento de presupuesto de proyecto. Filtra por proyecto/persona vía filters.',
      inputSchema: {
        startTime: TS,
        endTime: TS,
        filters: z.array(z.record(z.string(), z.unknown())).optional(),
        taskCategoryId: ID.optional(),
        periodSplit: z.string().optional().describe('p.ej. "month", "week".'),
      },
      annotations: RO,
    },
    guard(async (a) => {
      const { decls, args, variables } = gqlArgs([
        { name: 'startTime', type: 'BeeboleTimestamp!', value: a.startTime },
        { name: 'endTime', type: 'BeeboleTimestamp!', value: a.endTime },
        { name: 'filters', type: '[BeeboleReportFilter]', value: a.filters },
        { name: 'taskCategoryId', type: 'BeeboleId', value: a.taskCategoryId },
        { name: 'periodSplit', type: 'String', value: a.periodSplit },
      ]);
      const q = `query${decls}{ getPlannedVsRealReport${args}{ ${selection('BeebolePlannedVsRealResult', 1)} } }`;
      return ok(await beebole.graphql(q, variables));
    }),
  );

  // ── A) Altas de catálogo ───────────────────────────────────────────────────

  server.registerTool(
    'beebole_add_project',
    {
      title: 'Crear proyecto',
      description: 'Crea un proyecto. color = índice de paleta 0-71.',
      inputSchema: {
        name: z.string().min(1).max(160),
        categoryId: ID.optional(),
        parentId: ID.optional(),
        color: z.number().int().min(0).max(71).optional(),
      },
      annotations: WR,
    },
    guard(async (a) => {
      const { decls, args, variables } = gqlArgs([
        { name: 'name', type: 'BeeboleName!', value: a.name },
        { name: 'categoryId', type: 'BeeboleId', value: a.categoryId },
        { name: 'parentId', type: 'BeeboleId', value: a.parentId },
        { name: 'color', type: 'BeeboleColor', value: a.color },
      ]);
      const q = `mutation${decls}{ addProject${args}{ ${SEL_PROJECT()} } }`;
      return ok(await beebole.graphql(q, variables));
    }),
  );

  server.registerTool(
    'beebole_add_task',
    {
      title: 'Crear tarea',
      description: 'Crea una tarea (opcionalmente bajo un proyecto/padre y con estado/categoría).',
      inputSchema: {
        name: z.string().min(1).max(160),
        categoryId: ID.optional(),
        parentId: ID.optional(),
        statusId: ID.optional(),
        color: z.number().int().min(0).max(71).optional(),
      },
      annotations: WR,
    },
    guard(async (a) => {
      const { decls, args, variables } = gqlArgs([
        { name: 'name', type: 'BeeboleName!', value: a.name },
        { name: 'categoryId', type: 'BeeboleId', value: a.categoryId },
        { name: 'parentId', type: 'BeeboleId', value: a.parentId },
        { name: 'statusId', type: 'BeeboleId', value: a.statusId },
        { name: 'color', type: 'BeeboleColor', value: a.color },
      ]);
      const q = `mutation${decls}{ addTask${args}{ ${SEL_TASK()} } }`;
      return ok(await beebole.graphql(q, variables));
    }),
  );

  server.registerTool(
    'beebole_add_person',
    {
      title: 'Crear persona',
      description: 'Da de alta una persona (usuario). roleId es obligatorio (ver roles de la organización).',
      inputSchema: {
        name: z.string().min(1).max(160),
        email: z.string().email(),
        roleId: ID,
        color: z.number().int().min(0).max(71).optional(),
      },
      annotations: WR,
    },
    guard(async (a) => {
      const { decls, args, variables } = gqlArgs([
        { name: 'name', type: 'BeeboleName!', value: a.name },
        { name: 'email', type: 'BeeboleEmail!', value: a.email },
        { name: 'roleId', type: 'BeeboleId!', value: a.roleId },
        { name: 'color', type: 'BeeboleColor', value: a.color },
      ]);
      const q = `mutation${decls}{ addPerson${args}{ ${SEL_PERSON()} } }`;
      return ok(await beebole.graphql(q, variables));
    }),
  );

  // ── B) Genéricas: cobertura del 100% de la API ─────────────────────────────

  server.registerTool(
    'beebole_search_schema',
    {
      title: 'Buscar operaciones en la API',
      description:
        'Descubre cualquiera de las 87 queries + 745 mutations de Beebole por palabra clave (nombre o descripción). Úsalo cuando no haya una tool curada para lo que necesitas; luego beebole_describe_operation y beebole_graphql.',
      inputSchema: {
        keyword: z.string().min(2).describe('Palabra(s) clave. Ej: "absence quota", "expense", "schedule".'),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: RO,
    },
    guard(async (a) => {
      const hits = searchOps(a.keyword, a.limit ?? 40);
      const text = hits.length
        ? hits.map((h) => `[${h.kind}] ${h.signature}${h.description ? `\n    ${h.description}` : ''}`).join('\n')
        : 'Sin coincidencias.';
      return { content: [{ type: 'text', text }], structuredContent: { count: hits.length, operations: hits } };
    }),
  );

  server.registerTool(
    'beebole_describe_operation',
    {
      title: 'Describir una operación',
      description:
        'Devuelve la firma completa de una query/mutation: argumentos, expansión de los input objects, scalars con sus valores permitidos y forma del tipo de retorno. Úsalo antes de llamar a beebole_graphql.',
      inputSchema: { name: z.string().min(1).describe('Nombre exacto, p.ej. "addAbsenceType".') },
      annotations: RO,
    },
    guard(async (a) => {
      const desc = describeOp(a.name);
      if (!desc) throw new BeeboleError(`No existe la operación "${a.name}". Usa beebole_search_schema para encontrarla.`);
      return { content: [{ type: 'text', text: desc }] };
    }),
  );

  server.registerTool(
    'beebole_graphql',
    {
      title: 'Ejecutar GraphQL crudo',
      description:
        'Ejecuta una query o mutation GraphQL arbitraria contra Beebole (cobertura total de la API). Pasa el documento en `query` y opcionalmente `variables`. Para operaciones sin tool curada, descúbrelas con beebole_search_schema + beebole_describe_operation. Puede modificar datos: úsalo con cuidado.',
      inputSchema: {
        query: z.string().min(1).describe('Documento GraphQL (query o mutation, con sus variables declaradas).'),
        variables: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: DESTR,
    },
    guard(async (a) => {
      return ok(await beebole.graphql(a.query, a.variables ?? {}));
    }),
  );

  return server;
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Aplica los cambios indicados a un time record usando las mutaciones fine-grained
 * (una por campo) en UN solo documento con alias. Devuelve el record final, o null
 * si no había nada que cambiar.
 */
async function applyTimeRecordEdits(
  beebole: BeeboleClient,
  id: string,
  fields: {
    comment?: string;
    durationMinutes?: number;
    startTime?: number;
    endTime?: number;
    taskId?: string;
    projectIds?: string[];
    nonBillable?: boolean;
    wfh?: boolean;
  },
): Promise<unknown | null> {
  const map: { key: keyof typeof fields; mut: string; arg: string; type: string }[] = [
    { key: 'comment', mut: 'editTimeRecordComment', arg: 'comment', type: 'String!' },
    { key: 'durationMinutes', mut: 'editTimeRecordDuration', arg: 'duration', type: 'Int!' },
    { key: 'startTime', mut: 'editTimeRecordStartTime', arg: 'startTime', type: 'BeeboleTimestamp' },
    { key: 'endTime', mut: 'editTimeRecordEndTime', arg: 'endTime', type: 'BeeboleTimestamp' },
    { key: 'taskId', mut: 'editTimeRecordTask', arg: 'taskId', type: 'BeeboleId!' },
    { key: 'projectIds', mut: 'editTimeRecordProjects', arg: 'projectIds', type: '[BeeboleId]!' },
    { key: 'nonBillable', mut: 'editTimeRecordNonBillable', arg: 'nonBillable', type: 'Boolean!' },
    { key: 'wfh', mut: 'editTimeRecordWfh', arg: 'wfh', type: 'Boolean!' },
  ];
  const active = map.filter((m) => fields[m.key] !== undefined);
  if (active.length === 0) return null;

  const decls = ['$id: BeeboleId!', ...active.map((m) => `$${m.arg}: ${m.type}`)].join(', ');
  const calls = active.map((m, i) => `a${i}: ${m.mut}(id: $id, ${m.arg}: $${m.arg}){ ${SEL_TR()} }`).join('\n');
  const variables: Record<string, unknown> = { id };
  for (const m of active) variables[m.arg] = m.key === 'durationMinutes' ? fields.durationMinutes : fields[m.key];

  const q = `mutation(${decls}){\n${calls}\n}`;
  const data = await beebole.graphql<Record<string, unknown>>(q, variables);
  return data[`a${active.length - 1}`] ?? data;
}
