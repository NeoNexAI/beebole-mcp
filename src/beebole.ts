/**
 * Cliente de la API de Beebole.
 *
 * Construido sobre la API LEGACY JSON-RPC (verificada: endpoint, auth basic
 * token:x, servicios get_entities / get_tasks / time_entry.*). La API GraphQL
 * moderna existe pero su doc está tras un SPA no scrapeable → cuando tengamos
 * una API key real haremos el "spike" de introspección y, si compensa, migramos.
 *
 * ⚠️ PENDIENTE DE VERIFICAR CON KEY REAL (marcado // [spike]):
 *   - nombre exacto del filtro de fechas en time_entry.export
 *   - forma del jobId y del polling (time_entry.get_job_info)
 *   - shape de la respuesta de cada servicio
 * El código es tolerante (devuelve el JSON crudo a Claude) para no romper si la
 * forma difiere; los ajustes tras el spike son triviales.
 */

const ENDPOINT = 'https://beebole-apps.com/api/v2';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class BeeboleError extends Error {}

export class BeeboleClient {
  constructor(private readonly apiToken: string) {
    if (!apiToken || !apiToken.trim()) {
      throw new BeeboleError('Falta la API key de Beebole.');
    }
  }

  /** Llamada base JSON-RPC. Auth HTTP Basic: usuario = token, password = "x". */
  private async call(payload: Record<string, unknown>): Promise<unknown> {
    const auth = Buffer.from(`${this.apiToken}:x`).toString('base64');
    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${auth}`,
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new BeeboleError(`No se pudo contactar con Beebole: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new BeeboleError(`Beebole HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new BeeboleError(`Respuesta no-JSON de Beebole: ${text.slice(0, 200)}`);
    }
    if (data && typeof data === 'object' && (data as Record<string, unknown>).status === 'error') {
      throw new BeeboleError(`Beebole error: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return data;
  }

  /** Jerarquía de empresa / proyectos / subproyectos. Síncrono. */
  listEntities(): Promise<unknown> {
    return this.call({ service: 'get_entities' });
  }

  /** Catálogo de tareas. Síncrono. */
  listTasks(): Promise<unknown> {
    return this.call({ service: 'get_tasks' });
  }

  /**
   * Registros de horas en un rango de fechas. La API legacy lo hace ASÍNCRONO:
   * lanza un job (time_entry.export) → se hace polling de time_entry.get_job_info
   * hasta status == done. // [spike] confirmar nombres de campos.
   */
  async exportTimeEntries(input: { from: string; to: string }): Promise<unknown> {
    const launched = (await this.call({
      service: 'time_entry.export',
      filters: { from: input.from, to: input.to }, // [spike] confirmar clave de filtro
    })) as Record<string, unknown>;

    const jobId =
      launched?.jobId ?? launched?.job_id ?? launched?.id ?? launched?.job ?? null;
    if (!jobId) return launched; // si fuera síncrono o cambió la forma, devolvemos lo recibido

    for (let i = 0; i < 16; i++) {
      await sleep(2500);
      const info = (await this.call({
        service: 'time_entry.get_job_info',
        jobId,
      })) as Record<string, unknown>;
      const status = String(info?.status ?? '').toLowerCase();
      if (status === 'done' || status === 'finished' || status === 'completed') return info;
      if (status === 'error' || status === 'failed') {
        throw new BeeboleError(`El export de horas falló: ${JSON.stringify(info).slice(0, 300)}`);
      }
    }
    throw new BeeboleError('El export de horas tardó demasiado (timeout). Reduce el rango de fechas.');
  }

  /** Alta de un registro de horas. // [spike] confirmar campos requeridos. */
  createTimeEntry(input: {
    projectId: string;
    date: string;
    durationMinutes: number;
    taskId?: string;
    comment?: string;
  }): Promise<unknown> {
    return this.call({
      service: 'time_entry.create',
      time_entry: {
        project: input.projectId,
        date: input.date,
        duration: input.durationMinutes,
        ...(input.taskId ? { task: input.taskId } : {}),
        ...(input.comment ? { comment: input.comment } : {}),
      },
    });
  }
}
