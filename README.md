# @neonexai/beebole-mcp

MCP server que conecta **Claude** (Claude Code / Claude Desktop) con **Beebole**
(control de horas) a través de su **API GraphQL nueva** — la de la app rediseñada
**`app.beebole.com`**.

- **Endpoint:** `POST https://app.beebole.com/graphql`
- **Auth:** cabecera `apikey: <API_KEY>` (la key se obtiene en `app.beebole.com → Settings → API`).
- **Verificado e2e** (2026-06-25) contra la API real: 18/18 checks de lectura y
  escritura (crear proyecto/tarea, fichar horas, editar, borrar, limpiar).

Dos transportes:

- **Local (stdio)** — *recomendado (GDPR)*: corre en el PC del cliente; su API key
  vive solo en su máquina y los datos no pasan por ningún servidor intermedio.
- **Remoto (HTTP, VPS)** — centralizado; el token viaja por cabecera
  `X-Beebole-Key` en cada petición y **no se almacena** (stateless multi-tenant).

---

## Arquitectura: híbrida (curadas + passthrough)

La API GraphQL nueva es enorme y *fine-grained*: **87 queries + 745 mutations**
(cada campo editable tiene su propia mutation). Exponer eso 1:1 saturaría a
cualquier agente. Por eso el server combina dos capas:

**A) ~24 tools curadas** para el flujo real de un estudio:

| Área | Tools |
|---|---|
| Identidad | `beebole_whoami` |
| Proyectos | `beebole_list_projects`, `beebole_get_project`, `beebole_add_project` |
| Tareas | `beebole_list_tasks`, `beebole_get_task`, `beebole_add_task` |
| Personas | `beebole_list_persons`, `beebole_get_person`, `beebole_add_person` |
| Fichaje de horas | `beebole_list_time_records`, `beebole_count_time_records`, `beebole_add_time_record`, `beebole_edit_time_record`, `beebole_delete_time_records`, `beebole_clone_time_records` |
| Timesheets | `beebole_submit_timesheet`, `beebole_approve_timesheet`, `beebole_reject_timesheet` |
| Catálogos | `beebole_list_tags`, `beebole_list_absence_types` |
| Informes | `beebole_list_reports`, `beebole_run_report`, `beebole_planned_vs_real` |

**B) 3 tools genéricas** para cobertura del **100%** de la API (las ~800
operaciones restantes de administración/configuración):

- `beebole_search_schema` — descubre cualquier operación por palabra clave.
- `beebole_describe_operation` — su firma completa (args + input objects + retorno).
- `beebole_graphql` — ejecuta cualquier query/mutation cruda.

Flujo para algo sin tool curada: **search → describe → graphql**.

### Notas de dominio (del propio schema)

- **Timestamps**: `BeeboleTimestamp` = Unix epoch en **milisegundos** (`> 1e10`).
- **Duración** de un time record: entero en **minutos** (ej. `90` = 1 h 30 min).
  Beebole lo interpreta según los *time settings* de la organización; confírmalo
  visualmente la primera vez.
- **Estados** (`status`): `d`=draft, `s`=submitted, `a`=approved, `r`=rejected.
- **Color**: índice de paleta `0-71`. **Ausencias**: unidad `day` o `hour`.
- `addProject` / `addTask` requieren **`categoryId` o `parentId`** (la API
  rechaza con `NoCategoryOrParentProvided` si no se da ninguno).

---

## Instalación

Requisitos: **Node ≥ 18** y una **API key de Beebole** (`app.beebole.com → Settings → API`).

### A) Local en el PC del cliente (recomendado · stdio)

Se ejecuta directamente desde GitHub con `npx`, sin clonar nada:

```bash
claude mcp add beebole \
  --env BEEBOLE_API_KEY=TU_API_KEY \
  -- npx -y github:NeoNexAI/beebole-mcp
```

- `-s user` (scope usuario) lo deja disponible en **todos los proyectos** de ese PC:
  ```bash
  claude mcp add beebole -s user --env BEEBOLE_API_KEY=TU_API_KEY -- npx -y github:NeoNexAI/beebole-mcp
  ```
- En **Claude Desktop**, añade el bloque equivalente en su `mcp.json`:
  ```json
  {
    "mcpServers": {
      "beebole": {
        "command": "npx",
        "args": ["-y", "github:NeoNexAI/beebole-mcp"],
        "env": { "BEEBOLE_API_KEY": "TU_API_KEY" }
      }
    }
  }
  ```

Verifica la key **antes** de añadirlo (debe responder con tu nombre):

```bash
curl -s -H "apikey: TU_API_KEY" -H "Content-Type: application/json" \
  -X POST https://app.beebole.com/graphql \
  -d '{"query":"{ currentPerson{ id name email } }"}'
```

### B) Despliegue para un equipo (plan Team)

No hay un “instalar para toda la organización” de un click para un MCP propio: cada
equipo lo corre **en local** (stdio) con la API key correspondiente. Para
estandarizarlo en varios PCs:

- **Misma cuenta Beebole de empresa** → repartid la **misma API key** (cada PC la
  pone en su `BEEBOLE_API_KEY`; nunca en el repo).
- **Cada persona con su propio usuario Beebole** → cada PC usa **su** API key (el
  server actúa siempre como esa persona).
- Para fijar la config en un repo compartido, commitea un `.mcp.json` (scope
  *project*) **sin la key** y que cada entorno aporte `BEEBOLE_API_KEY` por
  variable de entorno. La key es un secreto: **nunca** se commitea.

> Alternativa centralizada: desplegar el modo **HTTP** en el VPS (un solo sitio) y
> que cada cliente Claude apunte ahí enviando su token por `X-Beebole-Key`. Útil si
> no quieres instalar Node en cada PC; menos recomendable para datos GDPR sensibles.

---

## Desarrollo

```bash
npm install
npm run build          # tsc → dist/  (incluye schema.json para selección/búsqueda)
npm run typecheck
BEEBOLE_API_KEY=... npm run smoke           # 9 checks de lectura e2e
BEEBOLE_API_KEY=... SMOKE_WRITE=1 npm run smoke   # + ciclo de escritura (SOLO cuenta de pruebas)
```

El `smoke` con `SMOKE_WRITE=1` crea entidades `ZZ_SMOKE_TEST_*`, ficha, edita y
**borra todo** al terminar; úsalo solo en una cuenta de pruebas.

### Modo HTTP (VPS)

```bash
MCP_TRANSPORT=http PORT=8087 node dist/index.js
# POST /mcp con cabecera X-Beebole-Key: <token>   ·   GET /health
```

---

## Estructura

```
src/
  index.ts    — entry point (stdio | HTTP)
  client.ts   — cliente GraphQL (auth apikey) + helpers de schema (selección/búsqueda/describe)
  tools.ts    — registro de las 27 tools (factoría buildServer(apiKey))
  smoke.ts    — test e2e contra la API real
schema.json   — introspección de la API (bundleada; potencia selección + search/describe)
```

---

*Beebole API GraphQL — auth y endpoint verificados empíricamente 2026-06-25. Las
funciones de Beebole evolucionan; reverificar en `app.beebole.com` ante cambios.*
