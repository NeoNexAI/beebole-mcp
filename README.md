# @neonexai/beebole-mcp

MCP server que conecta **Claude** con **Beebole** (control de horas). Dos modos:

- **Local (stdio)** — *recomendado para clientes (GDPR)*: corre en el PC del cliente; su API key vive solo en su máquina; los datos no pasan por nuestro servidor.
- **Remoto (HTTP, VPS)** — centralizado; el token viaja por cabecera `X-Beebole-Key` en cada petición y **no se almacena** (stateless multi-tenant).

> Construido sobre la API **legacy JSON-RPC** de Beebole (`POST beebole-apps.com/api/v2`, auth HTTP Basic `token:x`), la única con modelo de auth verificado. La API GraphQL moderna es más rica pero su cabecera de auth no está confirmada → futura migración con key + doc.

---

## Catálogo de tools (16)

Cubren toda la superficie legacy (~110 servicios) consolidada. Las de lectura/análisis primero; las de escritura llevan `readOnlyHint:false` y avisan de "confirmar antes".

| Tool | Tipo | Para qué |
|---|---|---|
| `beebole_list` | lectura | Lista companies, projects, subprojects, tasks, people, absence types o custom fields (de aquí salen los IDs) |
| `beebole_get` | lectura | Detalle de una entidad por id |
| `beebole_get_loggable_entities` | lectura | Árbol de dónde se pueden imputar horas en una fecha |
| `beebole_get_loggable_tasks` | lectura | Tareas disponibles para una entidad+fecha |
| `beebole_list_time_entries` | lectura | Imputaciones de UNA persona en un rango |
| **`beebole_export_time`** | lectura | **Export para análisis**: horas por proyecto/persona/tarea, desviaciones, rentabilidad |
| `beebole_log_time` | escritura | Registrar horas (hours decimal; task si la entidad la exige) |
| `beebole_update_time_entry` | escritura | Editar una imputación |
| `beebole_delete_time_entry` | escritura (destructiva) | Borrar una imputación |
| `beebole_timesheet` | escritura | submit / approve / reject / lock / unlock de timesheets |
| `beebole_manage_entity` | escritura | CRUD de company/project/subproject/task/person |
| `beebole_manage_membership` | escritura | Miembros y managers de company/project/subproject |
| `beebole_group_tree` | lectura | Árbol de grupos/tags |
| `beebole_manage_group` | escritura | Crear / renombrar / borrar grupos |
| `beebole_tag_entity` | escritura | Etiquetar una entidad con un grupo |
| `beebole_custom_field` | lectura+escritura | Definiciones y valores de custom fields |

Caso de uso estrella para Cota Zero: *"horas por proyecto este mes y dónde nos desviamos"* → `beebole_export_time` con `from`/`to`.

---

## ⚠️ SPIKE de verificación con key real (1 vez, bloqueante para "operativo")

Los nombres de servicio y el shape están mapeados contra la doc oficial legacy, pero **deben confirmarse en vivo** con una key real antes de marcar el MCP como verificado:

```bash
npm install
npm run build
BEEBOLE_API_KEY="LA_KEY" SMOKE_FROM=2026-05-01 SMOKE_TO=2026-05-31 npm run smoke
```

El smoke prueba 8 servicios de lectura e imprime `OK=n FALLO=n`. Si todo OK → verificado. Si algo falla, ajustar el servicio en `src/beebole.ts` y repetir.

---

## 🔌 Guía de conexión paso a paso (sesión 4)

> En la sesión 3 falló porque (a) no había una `BEEBOLE_API_KEY` válida → el server sale con código 1 y Claude lo marca como **caído/“not running”**, y (b) la config se escribió en `C:/Users/Usuario/.claude.json` (scope equivocado). Esta guía evita ambos.

**Paso 0 — Requisitos en el PC:** Node ≥ 18 y Git instalados (los pone la guía de la sesión 3).

**Paso 1 — Conseguir la API key (lo hace Cota Zero):**
1. Beebole → **Settings → Account** → habilitar **"Enable API calls"**.
2. Copiar el **API Token** (módulo "API Token"). Usar un usuario con permisos mínimos, no admin global.

**Paso 2 — Verificar la key ANTES de enchufarla a Claude** (clave para no caer en el "not running"):

```bash
# Debe responder JSON con status ok. Si da 401/403 → la key o "API calls" están mal.
curl -s -u "LA_KEY:x" -H "Content-Type: application/json" \
  -d '{"service":"company.list"}' https://beebole-apps.com/api/v2
```

**Paso 3 — Añadir el MCP a Claude Code con scope de USUARIO explícito** (no de proyecto → así vale en todas las carpetas y no se pierde):

```bash
claude mcp add -s user beebole \
  --env BEEBOLE_API_KEY=LA_KEY \
  -- npx -y github:NeoNexAI/beebole-mcp
```

**Paso 4 — Comprobar que está conectado:**

```bash
claude mcp list          # debe aparecer: beebole ✓ connected
```
o dentro de Claude Code: `/mcp` → `beebole` en verde. La **primera** ejecución de `npx` clona+compila (~1 min); las siguientes usan caché.

**Paso 5 — Probar de verdad:** *"Lista mis proyectos de Beebole"* (usa `beebole_list`), luego *"¿cuántas horas llevamos en el proyecto X este mes?"* (usa `beebole_export_time`).

### Troubleshooting "no conecta / not running"
| Síntoma | Causa | Solución |
|---|---|---|
| Sale como caído al instante | `BEEBOLE_API_KEY` ausente/inválida → exit 1 | Verificar la key con el curl del Paso 2 |
| 401/403 en las llamadas | "API calls" deshabilitado o key mala | Habilitar en Settings → Account; regenerar token |
| Aparece en un scope y no en otro | Config en `.claude.json` de proyecto | Reinstalar con `-s user` (Paso 3) |
| Tarda y luego va | Primer `npx` compilando | Esperar ~1 min la 1ª vez |

---

## Modo LOCAL (stdio) — Claude Desktop

Para Claude Desktop, en `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "beebole": {
      "command": "npx",
      "args": ["-y", "github:NeoNexAI/beebole-mcp"],
      "env": { "BEEBOLE_API_KEY": "LA_KEY" }
    }
  }
}
```

La key + los datos **nunca salen del PC** (solo hablan con Beebole). Reiniciar Claude Desktop tras editar el config.

---

## Modo REMOTO (HTTP, VPS)

1. Deploy en Coolify (Build Pack = Dockerfile), puerto host **8087**, vhost nginx `beebole-mcp.neonexai.com` + certbot (mismo patrón que el resto de apps NeoNex).
2. Conectar con la key en la cabecera:
   ```bash
   claude mcp add --transport http beebole \
     https://beebole-mcp.neonexai.com/mcp \
     --header "X-Beebole-Key: LA_KEY"
   ```
   Claude Desktop vía puente: `npx -y mcp-remote https://beebole-mcp.neonexai.com/mcp --header "X-Beebole-Key:LA_KEY"`.
3. Health: `GET https://beebole-mcp.neonexai.com/health` → `{"ok":true}`.

**Seguridad:** stateless (server efímero por petición), token no persistido ni loggeado, TLS obligatorio. La key hereda los permisos de su usuario en Beebole → permisos mínimos.

---

## Estado

- [x] Código: cliente legacy completo + **16 tools** + doble transporte + Docker
- [x] Build + typecheck verdes; roundtrip MCP (tools/list) verificado en memoria
- [ ] **Spike con key real** (`npm run smoke`) — bloqueante para "operativo-verificado"
- [ ] Conexión en el PC de Cota Zero (modo local, sesión 4)
- [x] skill-vetter SAFE (código propio, auditado)
