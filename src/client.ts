/**
 * Cliente de la API GraphQL de Beebole (app nueva, app.beebole.com).
 *
 *   - Endpoint:  POST https://app.beebole.com/graphql
 *   - Auth:      cabecera  apikey: <API_KEY>   (verificado empíricamente 2026-06-25;
 *                la key se encuentra en app.beebole.com › Settings › API)
 *   - Respuesta: { data, errors?, permissionsErrors? }
 *
 * La API GraphQL nueva es fine-grained (87 queries + 745 mutations). Este cliente
 * expone:
 *   1) `graphql()` — ejecutor crudo (lo usan las tools curadas y el passthrough).
 *   2) Helpers de SCHEMA bundleado (schema.json en la raíz del paquete):
 *        - `selection()`  genera selection-sets válidos sin hardcodear 267 tipos.
 *        - `searchOps()`  descubre operaciones por palabra clave.
 *        - `describeOp()` da la firma completa (args + input fields + retorno).
 *
 * Notas de dominio (de las descripciones del schema):
 *   - BeeboleTimestamp = Unix epoch en MILISEGUNDOS (> 1e10).
 *   - BeeboleApprovalStatus: d=draft, s=submitted, a=approved, r=rejected.
 *   - BeeboleColor: índice de paleta 0-71.  BeeboleAbsenceUnit: day|hour.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const BEEBOLE_GRAPHQL_ENDPOINT =
  process.env.BEEBOLE_GRAPHQL_ENDPOINT?.trim() || 'https://app.beebole.com/graphql';

export class BeeboleError extends Error {}

// ── Schema bundleado (introspección) ────────────────────────────────────────

interface TypeRef {
  kind: string;
  name: string | null;
  ofType?: TypeRef | null;
}
interface Arg {
  name: string;
  description?: string | null;
  defaultValue?: string | null;
  type: TypeRef;
}
interface Field {
  name: string;
  description?: string | null;
  args?: Arg[] | null;
  type: TypeRef;
}
interface IntrospType {
  kind: string;
  name: string | null;
  description?: string | null;
  fields?: Field[] | null;
  inputFields?: Arg[] | null;
  enumValues?: { name: string; description?: string | null }[] | null;
}

const schemaPath = fileURLToPath(new URL('../schema.json', import.meta.url));
const SCHEMA = JSON.parse(readFileSync(schemaPath, 'utf8')).data.__schema as {
  queryType: { name: string };
  mutationType: { name: string } | null;
  types: IntrospType[];
};

const TYPES = new Map<string, IntrospType>();
for (const t of SCHEMA.types) if (t.name) TYPES.set(t.name, t);

const QUERY_TYPE = TYPES.get(SCHEMA.queryType.name)!;
const MUTATION_TYPE = SCHEMA.mutationType ? TYPES.get(SCHEMA.mutationType.name) ?? null : null;

function unwrap(t: TypeRef | null | undefined): TypeRef | null {
  let cur = t ?? null;
  while (cur && cur.ofType) cur = cur.ofType;
  return cur;
}

/** Render legible de un TypeRef: BeeboleId!, [BeeboleId], etc. */
export function typeStr(t: TypeRef | null | undefined): string {
  if (!t) return '?';
  if (t.kind === 'NON_NULL') return `${typeStr(t.ofType)}!`;
  if (t.kind === 'LIST') return `[${typeStr(t.ofType)}]`;
  return t.name ?? '?';
}

function isLeaf(typeName: string | null | undefined): boolean {
  if (!typeName) return true;
  const t = TYPES.get(typeName);
  return !t || t.kind === 'SCALAR' || t.kind === 'ENUM';
}

/** Campos "resumen" de un objeto para profundidad de corte (id/name/fecha…). */
function shallow(typeName: string | null | undefined): string {
  if (!typeName) return '';
  const t = TYPES.get(typeName);
  if (!t || !t.fields) return '';
  const want = new Set(['id', 'name', 'iso', 'ts', 'email', 'status', 'duration', 'color', 'archived']);
  return t.fields
    .filter((f) => !(f.args && f.args.length) && want.has(f.name) && isLeaf(unwrap(f.type)?.name))
    .map((f) => f.name)
    .join(' ');
}

/**
 * Genera un selection-set GraphQL válido para un tipo OBJECT a partir del schema.
 * `depth` = niveles de expansión COMPLETA; más allá, los objetos se resumen a
 * {id name …}. depth=0 → escalares del tipo + objetos anidados resumidos
 * (ideal para listados); depth=1 → además expande un nivel (ideal para "get").
 * Salta campos que requieren argumentos (evita queries inválidas) y cicla-protege.
 */
export function selection(typeName: string, depth = 0, _seen: Set<string> = new Set()): string {
  const t = TYPES.get(typeName);
  if (!t || !t.fields) return '';
  if (_seen.has(typeName)) return '';
  const seen = new Set(_seen);
  seen.add(typeName);
  const parts: string[] = [];
  for (const f of t.fields) {
    if (f.args && f.args.length) continue;
    const baseName = unwrap(f.type)?.name;
    if (isLeaf(baseName)) {
      parts.push(f.name);
      continue;
    }
    if (depth <= 0) {
      const sh = shallow(baseName);
      if (sh) parts.push(`${f.name}{ ${sh} }`);
      continue;
    }
    const sub = selection(baseName!, depth - 1, seen);
    if (sub) parts.push(`${f.name}{ ${sub} }`);
  }
  return parts.join(' ');
}

interface OpInfo {
  kind: 'query' | 'mutation';
  name: string;
  description: string;
  signature: string;
}

function opSignature(f: Field): string {
  const args = (f.args ?? []).map((a) => `${a.name}: ${typeStr(a.type)}`).join(', ');
  return `${f.name}(${args}): ${typeStr(f.type)}`;
}

function allOps(): OpInfo[] {
  const out: OpInfo[] = [];
  for (const f of QUERY_TYPE.fields ?? [])
    out.push({ kind: 'query', name: f.name, description: f.description ?? '', signature: opSignature(f) });
  for (const f of MUTATION_TYPE?.fields ?? [])
    out.push({ kind: 'mutation', name: f.name, description: f.description ?? '', signature: opSignature(f) });
  return out;
}

/** Busca operaciones (query+mutation) cuyo nombre o descripción casan TODAS las palabras. */
export function searchOps(keyword: string, limit = 40): OpInfo[] {
  const terms = keyword.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = allOps().filter((o) => {
    const hay = `${o.name} ${o.description}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
  // Prioriza match en nombre sobre match solo en descripción.
  hits.sort((a, b) => {
    const an = terms.every((t) => a.name.toLowerCase().includes(t)) ? 0 : 1;
    const bn = terms.every((t) => b.name.toLowerCase().includes(t)) ? 0 : 1;
    return an - bn || a.name.localeCompare(b.name);
  });
  return hits.slice(0, limit);
}

/** Firma completa de una operación, con expansión de los input objects (1 nivel). */
export function describeOp(name: string): string | null {
  const f =
    (QUERY_TYPE.fields ?? []).find((x) => x.name === name) ??
    (MUTATION_TYPE?.fields ?? []).find((x) => x.name === name);
  if (!f) return null;
  const kind = (QUERY_TYPE.fields ?? []).some((x) => x.name === name) ? 'query' : 'mutation';
  const lines: string[] = [`${kind} ${opSignature(f)}`];
  if (f.description) lines.push(`  // ${f.description}`);
  for (const a of f.args ?? []) {
    const baseName = unwrap(a.type)?.name;
    const it = baseName ? TYPES.get(baseName) : null;
    if (it && it.kind === 'INPUT_OBJECT' && it.inputFields?.length) {
      lines.push(`  input ${baseName} {`);
      for (const inf of it.inputFields) lines.push(`    ${inf.name}: ${typeStr(inf.type)}`);
      lines.push('  }');
    }
    if (it && it.kind === 'SCALAR' && it.description) {
      lines.push(`  scalar ${baseName}: ${it.description}`);
    }
  }
  const retName = unwrap(f.type)?.name;
  if (retName && !isLeaf(retName)) lines.push(`  returns ${retName} { ${selection(retName, 0)} }`);
  return lines.join('\n');
}

// ── Cliente HTTP ────────────────────────────────────────────────────────────

export class BeeboleClient {
  private readonly endpoint: string;

  constructor(private readonly apiKey: string, endpoint = BEEBOLE_GRAPHQL_ENDPOINT) {
    if (!apiKey || !apiKey.trim()) throw new BeeboleError('Falta la API key de Beebole.');
    this.endpoint = endpoint;
  }

  /** Ejecuta una operación GraphQL. Devuelve `data`; lanza BeeboleError accionable. */
  async graphql<T = Record<string, unknown>>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          apikey: this.apiKey,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new BeeboleError(`No se pudo contactar con Beebole: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new BeeboleError(
        'Beebole rechazó la API key (HTTP ' +
          res.status +
          '). Verifica la key y que el acceso API esté habilitado en app.beebole.com › Settings.',
      );
    }
    let body: { data?: T; errors?: { message: string }[]; permissionsErrors?: string[] };
    try {
      body = JSON.parse(text);
    } catch {
      throw new BeeboleError(`Respuesta no-JSON de Beebole (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    if (body.errors?.length) {
      throw new BeeboleError('Beebole GraphQL error: ' + body.errors.map((e) => e.message).join('; ').slice(0, 500));
    }
    const data = body.data;
    const dataEmpty =
      !data ||
      typeof data !== 'object' ||
      Object.keys(data as object).length === 0 ||
      Object.values(data as object).every((v) => v == null);
    if (body.permissionsErrors?.length && dataEmpty) {
      throw new BeeboleError(
        'Beebole denegó permisos para: ' +
          body.permissionsErrors.join(', ') +
          '. La API key necesita un rol con acceso a esos datos.',
      );
    }
    return (data ?? ({} as T)) as T;
  }
}

/**
 * Construye `(decls)` y `(args)` GraphQL solo con los argumentos definidos, más
 * el objeto de variables. Evita "variable never used" declarando únicamente lo
 * que se pasa. Cada spec: { name, type (GraphQL), value }.
 */
export function gqlArgs(
  spec: { name: string; type: string; value: unknown }[],
): { decls: string; args: string; variables: Record<string, unknown> } {
  const used = spec.filter((s) => s.value !== undefined && s.value !== null);
  const decls = used.map((s) => `$${s.name}: ${s.type}`).join(', ');
  const args = used.map((s) => `${s.name}: $${s.name}`).join(', ');
  const variables: Record<string, unknown> = {};
  for (const s of used) variables[s.name] = s.value;
  return { decls: decls ? `(${decls})` : '', args: args ? `(${args})` : '', variables };
}
