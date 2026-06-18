# @neonexai/beebole-mcp

MCP server para conectar **Claude** con **Beebole** (control de horas). Dos modos:

- **Local (stdio)** — *recomendado para clientes (GDPR)*: corre en el PC del cliente; su API key vive solo en su máquina; los datos no pasan por nuestro servidor.
- **Remoto (HTTP, VPS)** — centralizado; el token del cliente viaja por cabecera `X-Beebole-Key` en cada petición y **no se almacena** (stateless multi-tenant).

Tools: `beebole_list_projects`, `beebole_list_tasks`, `beebole_get_time_entries` (rango de fechas), `beebole_log_time` (escritura, pide confirmación).

> Construido sobre la API **legacy JSON-RPC** de Beebole (`beebole-apps.com/api/v2`, auth Basic `token:x`), que está verificada. La API GraphQL moderna se evaluará en el spike.

---

## ⚠️ Antes de darlo por operativo: SPIKE de verificación (1 vez)

La forma exacta de algunas respuestas/parámetros de la API legacy está marcada `// [spike]` en `src/beebole.ts`. Con una API key real:

```bash
npm install
npm run build
BEEBOLE_API_KEY="LA_KEY" SMOKE_FROM=2026-05-01 SMOKE_TO=2026-05-31 npm run smoke
```

Si los 3 servicios devuelven datos → verificado. Si alguno falla, ajustar los puntos `// [spike]` (nombres de filtro/jobId/shape) y repetir. **Obtener la key:** en Beebole → Settings → API → copiar (usar un usuario con permisos mínimos, no admin global).

---

## Modo LOCAL (stdio) — recomendado para Cota Zero

1. Sacar la API key en Beebole (Settings → API).
2. En el PC del cliente, añadir el MCP a Claude:
   - **Claude Code:**
     ```bash
     claude mcp add beebole --env BEEBOLE_API_KEY=LA_KEY -- npx -y github:NeoNexAI/beebole-mcp
     ```
   - **Claude Desktop** (`claude_desktop_config.json`):
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
3. Reiniciar Claude. La key + los datos **nunca salen del PC del cliente** (solo hablan con Beebole).

> Publicado vía GitHub: `npx -y github:NeoNexAI/beebole-mcp` clona el repo, instala, compila (`prepare`) y arranca. Requiere **Node ≥18** en el PC. La primera ejecución tarda ~1 min (build); las siguientes usan caché de npx.

---

## Modo REMOTO (HTTP, VPS)

1. Build + deploy en Coolify (Build Pack = Dockerfile), puerto host **8087**, vhost nginx `beebole-mcp.neonexai.com` + certbot (mismo patrón que el resto de apps).
2. El cliente conecta con SU key en la cabecera:
   - **Claude Code:**
     ```bash
     claude mcp add --transport http beebole \
       https://beebole-mcp.neonexai.com/mcp \
       --header "X-Beebole-Key: LA_KEY"
     ```
   - **Claude Desktop** (vía puente `mcp-remote`):
     ```json
     {
       "mcpServers": {
         "beebole": {
           "command": "npx",
           "args": ["-y", "mcp-remote", "https://beebole-mcp.neonexai.com/mcp",
                    "--header", "X-Beebole-Key:LA_KEY"]
         }
       }
     }
     ```
3. Health check: `GET https://beebole-mcp.neonexai.com/health` → `{"ok":true}`.

**Seguridad:** stateless (server efímero por petición), el token no se persiste ni se loggea. TLS obligatorio. La key hereda los permisos de su usuario en Beebole → usar permisos mínimos.

---

## Estado

- [x] Código (cliente + 4 tools + doble transporte + Docker)
- [ ] **Spike de verificación con key real** (bloqueante para "operativo")
- [ ] skill-vetter SAFE (código propio)
- [ ] Conexión en el PG de Cota Zero (modo local) **o** deploy VPS
