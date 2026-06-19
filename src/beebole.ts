/**
 * Cliente de la API de Beebole.
 *
 * Construido sobre la API LEGACY JSON-RPC, la única con un modelo de
 * autenticación verificado (HTTP Basic, usuario = API token, password = "x").
 *   - Endpoint:  POST https://beebole-apps.com/api/v2
 *   - Cuerpo:    { "service": "<recurso.accion>", ...params }
 *   - Respuesta: { "status": "ok" | "error", ... }  (en error trae "message")
 *   - Límites de cuenta: 2048 KB/día y 4000 req/día por usuario.
 *
 * La superficie de servicios (recurso.accion) está mapeada contra la doc oficial
 * legacy (https://beebole.com/help/legacy/api). La API GraphQL moderna
 * (app.beebole.com/graphql) es más rica pero la cabecera de auth para su API key
 * NO está verificada → se deja para una futura migración cuando haya key + doc.
 *
 * ⚠️ Antes de marcar el server como "operativo-verificado" hay que pasar el
 *    smoke (npm run smoke) con una API key real: confirma nombres de servicio,
 *    el shape de las respuestas y el polling del export. El cliente es tolerante
 *    (devuelve el JSON crudo) para no romper si algún shape difiere.
 */

const DEFAULT_ENDPOINT = 'https://beebole-apps.com/api/v2';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class BeeboleError extends Error {}

/** Referencia a una entidad imputable: exactamente una de estas claves. */
export type EntityRef =
  | { company: string }
  | { project: string }
  | { subproject: string }
  | { absence: string };

export type EntityKind = 'company' | 'project' | 'subproject' | 'person' | 'task' | 'group';

export class BeeboleClient {
  private readonly endpoint: string;

  constructor(private readonly apiToken: string, endpoint = DEFAULT_ENDPOINT) {
    if (!apiToken || !apiToken.trim()) {
      throw new BeeboleError('Falta la API key de Beebole.');
    }
    this.endpoint = endpoint;
  }

  /** Llamada base JSON-RPC. Auth HTTP Basic: usuario = token, password = "x". */
  async call(service: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const auth = Buffer.from(`${this.apiToken}:x`).toString('base64');
    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${auth}`,
          Accept: 'application/json',
        },
        body: JSON.stringify({ service, ...params }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new BeeboleError(`No se pudo contactar con Beebole: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new BeeboleError(
        'Beebole rechazó la autenticación (401/403). Revisa la API key y que "API calls" esté habilitado en Settings › Account.',
      );
    }
    if (!res.ok) {
      throw new BeeboleError(`Beebole HTTP ${res.status} en "${service}": ${text.slice(0, 300)}`);
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new BeeboleError(`Respuesta no-JSON de Beebole en "${service}": ${text.slice(0, 200)}`);
    }
    const obj = data as Record<string, unknown>;
    if (obj && typeof obj === 'object' && obj.status === 'error') {
      const msg = typeof obj.message === 'string' ? obj.message : JSON.stringify(obj).slice(0, 300);
      throw new BeeboleError(`Beebole error en "${service}": ${msg}`);
    }
    return data;
  }

  // ── Catálogos / listados ──────────────────────────────────────────────

  /** Lista companies, projects, subprojects, tasks, people, absence types o custom fields. */
  list(
    entity: 'company' | 'project' | 'subproject' | 'task' | 'person' | 'absence' | 'custom_field',
    parentId?: string,
  ): Promise<unknown> {
    const params: Record<string, unknown> = {};
    if (entity === 'project' && parentId) params.company = { id: parentId };
    if (entity === 'subproject' && parentId) params.project = { id: parentId };
    return this.call(`${entity}.list`, params);
  }

  /** Detalle de una entidad por id. */
  get(entity: EntityKind, id: string): Promise<unknown> {
    return this.call(`${entity}.get`, { id });
  }

  // ── Time records (núcleo) ─────────────────────────────────────────────

  /**
   * Navega el árbol company › project › subproject para una fecha y descubre
   * las entidades hoja donde se pueden imputar horas. Sin parent → raíz.
   */
  getLoggableEntities(date: string, parent?: EntityRef): Promise<unknown> {
    return this.call('time_entry.get_entities', { date, ...(parent ?? {}) });
  }

  /** Tareas disponibles para imputar en una entidad y fecha concretas. */
  getLoggableTasks(date: string, entity: EntityRef): Promise<unknown> {
    return this.call('time_entry.get_tasks', { date, ...entityRef(entity) });
  }

  /** Imputaciones de una persona en un rango (lista directa, no export). */
  listTimeEntries(personId: string, from: string, to: string): Promise<unknown> {
    return this.call('time_entry.list', { person: { id: personId }, from, to });
  }

  /** Una imputación concreta por id + fecha. */
  getTimeEntry(id: string, date: string): Promise<unknown> {
    return this.call('time_entry.get', { id, date });
  }

  /** Alta de imputación. hours en formato decimal (1.5 = 1 h 30 min). */
  createTimeEntry(input: {
    entity: EntityRef;
    date: string;
    hours: number;
    taskId?: string;
    comment?: string;
    xid?: string;
  }): Promise<unknown> {
    return this.call('time_entry.create', {
      ...entityRef(input.entity),
      date: input.date,
      hours: input.hours,
      ...(input.taskId ? { task: { id: input.taskId } } : {}),
      ...(input.comment ? { comment: input.comment } : {}),
      ...(input.xid ? { xid: input.xid } : {}),
    });
  }

  /** Actualiza una imputación existente. */
  updateTimeEntry(input: {
    id: string;
    date: string;
    entity?: EntityRef;
    hours?: number;
    taskId?: string;
    comment?: string;
  }): Promise<unknown> {
    return this.call('time_entry.update', {
      id: input.id,
      date: input.date,
      ...(input.entity ? entityRef(input.entity) : {}),
      ...(input.hours != null ? { hours: input.hours } : {}),
      ...(input.taskId ? { task: { id: input.taskId } } : {}),
      ...(input.comment != null ? { comment: input.comment } : {}),
    });
  }

  /** Borra una imputación por id + fecha. */
  deleteTimeEntry(id: string, date: string): Promise<unknown> {
    return this.call('time_entry.delete', { id, date });
  }

  // ── Reporte / export (análisis) ───────────────────────────────────────

  /**
   * Export de time records: lanza un job y hace polling de get_job_info hasta
   * que termina, devolviendo las filas (CSV o array de arrays según outputFormat).
   * Es la herramienta de análisis: rango + filtros opcionales por grupo/estado/entidad.
   */
  async exportTime(input: {
    from: string;
    to: string;
    outputFormat?: 'array' | 'csv';
    statusFilters?: string[];
    gids?: string[];
    entity?: EntityRef;
  }): Promise<unknown> {
    const outputFormat = input.outputFormat ?? 'array';
    const launchParams: Record<string, unknown> = {
      from: input.from,
      to: input.to,
      outputFormat,
    };
    if (input.statusFilters?.length) launchParams.statusFilters = input.statusFilters;
    if (input.gids?.length) launchParams.gids = input.gids;
    if (input.entity) Object.assign(launchParams, entityRef(input.entity));

    const launched = (await this.call('time_entry.export', launchParams)) as Record<string, unknown>;
    const jobId = pickJobId(launched);
    if (!jobId) return launched; // export síncrono o forma distinta → devolvemos lo recibido

    for (let i = 0; i < 24; i++) {
      await sleep(2500);
      const info = (await this.call('time_entry.get_job_info', {
        id: jobId,
        outputFormat,
      })) as Record<string, unknown>;
      const status = String((info?.status ?? (info?.job as Record<string, unknown>)?.status) ?? '').toLowerCase();
      if (['done', 'finished', 'completed', 'ok'].includes(status)) return info;
      if (['error', 'failed'].includes(status)) {
        throw new BeeboleError(`El export de horas falló: ${JSON.stringify(info).slice(0, 300)}`);
      }
    }
    throw new BeeboleError('El export de horas tardó demasiado (timeout). Reduce el rango de fechas o añade filtros.');
  }

  // ── Timesheets: aprobación / bloqueo ──────────────────────────────────

  /**
   * Acciones de workflow sobre el timesheet de una persona: submit, approve,
   * reject (requiere memo), lock, unlock. Por rango (from+to) o entry (id+date).
   */
  timesheetAction(input: {
    action: 'submit' | 'approve' | 'reject' | 'lock' | 'unlock';
    personId: string;
    from?: string;
    to?: string;
    entryId?: string;
    date?: string;
    memo?: string;
  }): Promise<unknown> {
    const scope: Record<string, unknown> =
      input.entryId && input.date
        ? { id: input.entryId, date: input.date }
        : { from: input.from, to: input.to };
    return this.call(`time_entry.${input.action}`, {
      person: { id: input.personId },
      ...scope,
      ...(input.memo ? { memo: input.memo } : {}),
    });
  }

  // ── Gestión de catálogo (create/update/activate/deactivate) ───────────

  /** CRUD genérico sobre company/project/subproject/task/person. */
  manage(
    entity: 'company' | 'project' | 'subproject' | 'task' | 'person',
    action: 'create' | 'update' | 'activate' | 'deactivate',
    payload: { id?: string; fields?: Record<string, unknown> },
  ): Promise<unknown> {
    if (action === 'activate' || action === 'deactivate') {
      return this.call(`${entity}.${action}`, { id: payload.id });
    }
    // create / update: el cuerpo va bajo la clave del recurso
    const body: Record<string, unknown> = { ...(payload.fields ?? {}) };
    if (action === 'update' && payload.id) body.id = payload.id;
    return this.call(`${entity}.${action}`, { [entity]: body });
  }

  // ── Relaciones: miembros, managers ────────────────────────────────────

  /** Adjunta/desadjunta personas o grupos (y managers en project) a un scope. */
  membership(input: {
    op: 'attach_member' | 'detach_member' | 'attach_manager' | 'detach_manager';
    scope: 'company' | 'project' | 'subproject';
    scopeId: string;
    personId?: string;
    groupId?: string;
  }): Promise<unknown> {
    const ref = input.personId ? { person: { id: input.personId } } : { group: { id: input.groupId } };
    return this.call(`${input.scope}.${input.op}`, { id: input.scopeId, ...ref });
  }

  // ── Grupos / tags ─────────────────────────────────────────────────────

  /** Árbol jerárquico completo de grupos/tags. */
  groupTree(): Promise<unknown> {
    return this.call('group.tree');
  }

  /** Entidades asignadas a un grupo. */
  groupAssignments(groupId: string): Promise<unknown> {
    return this.call('group.assignments', { id: groupId });
  }

  /** Gestión de grupos: create / update / delete. */
  manageGroup(
    action: 'create' | 'update' | 'delete',
    payload: { id?: string; name?: string; parentId?: string },
  ): Promise<unknown> {
    if (action === 'delete') return this.call('group.delete', { id: payload.id });
    const body: Record<string, unknown> = {};
    if (payload.name) body.name = payload.name;
    if (payload.parentId) body.parent = { id: payload.parentId };
    if (action === 'update' && payload.id) body.id = payload.id;
    return this.call(`group.${action}`, { group: body });
  }

  /** Adjunta/desadjunta una entidad a un grupo (tag). */
  tagEntity(input: {
    op: 'add_group' | 'remove_group';
    entity: 'company' | 'project' | 'subproject' | 'task' | 'person' | 'absence';
    entityId: string;
    groupId: string;
  }): Promise<unknown> {
    return this.call(`${input.entity}.${input.op}`, {
      id: input.entityId,
      group: { id: input.groupId },
    });
  }

  // ── Custom fields ─────────────────────────────────────────────────────

  /** Define los custom fields existentes (id, name, availableFor). */
  listCustomFields(): Promise<unknown> {
    return this.call('custom_field.list');
  }

  /** Lee los valores de custom field de una entidad. */
  getCustomFieldValues(
    entity: 'company' | 'project' | 'subproject' | 'person',
    entityId: string,
  ): Promise<unknown> {
    return this.call(`${entity}.custom_fields`, { id: entityId });
  }

  /** Establece o borra el valor de un custom field en una entidad. */
  setCustomFieldValue(input: {
    entity: 'company' | 'project' | 'subproject' | 'person';
    entityId: string;
    customFieldId: string;
    value?: string; // ausente → clear
  }): Promise<unknown> {
    if (input.value == null) {
      return this.call(`${input.entity}.clear_custom_field_value`, {
        id: input.entityId,
        customField: { id: input.customFieldId },
      });
    }
    return this.call(`${input.entity}.set_custom_field_value`, {
      id: input.entityId,
      customField: { id: input.customFieldId, value: input.value },
    });
  }
}

// ── helpers ─────────────────────────────────────────────────────────────

/** Normaliza una EntityRef {company:"id"} → {company:{id:"id"}} para el cuerpo JSON-RPC. */
function entityRef(ref: EntityRef): Record<string, unknown> {
  const [[k, v]] = Object.entries(ref);
  return { [k]: { id: v } };
}

function pickJobId(launched: Record<string, unknown> | null | undefined): string | null {
  if (!launched) return null;
  const job = launched.job as Record<string, unknown> | undefined;
  const candidate =
    launched.jobId ?? launched.job_id ?? launched.id ?? job?.id ?? (typeof launched.job === 'string' ? launched.job : null);
  return candidate != null ? String(candidate) : null;
}
