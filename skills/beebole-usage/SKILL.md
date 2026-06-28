---
name: beebole-usage
description: >-
  Guía para manejar bien el MCP de Beebole (control de horas). Úsala SIEMPRE que
  el trabajo implique Beebole o cualquier tool `beebole_*` — fichar/consultar
  horas, proyectos, tareas, personas, timesheets (aprobar/rechazar) o informes de
  dedicación y rentabilidad. Explica el flujo correcto (curadas → search/describe/
  graphql) y los gotchas de dominio (duración en MINUTOS, timestamps en
  MILISEGUNDOS, categoría obligatoria al crear) que, si se ignoran, hacen fallar
  las llamadas. Aunque el usuario no nombre "Beebole", si habla de fichajes,
  partes de horas o dedicación por proyecto y el MCP está disponible, aplícala.
---

# Beebole — cómo usar el MCP bien

El MCP habla con la API **GraphQL** de `app.beebole.com` (auth por cabecera
`apikey`). Tiene **24 tools curadas** para el flujo normal de un estudio y **3
genéricas** que cubren el 100% de la API (87 queries + 745 mutations). Tu trabajo
es resolver la petición con el mínimo de llamadas y sin tropezar con el dominio.

## Regla de oro de selección

1. **¿Hay una tool curada para esto?** Úsala. Cubren lo habitual:
   - Identidad: `beebole_whoami`
   - Proyectos: `beebole_list_projects`, `beebole_get_project`, `beebole_add_project`
   - Tareas: `beebole_list_tasks`, `beebole_get_task`, `beebole_add_task`
   - Personas: `beebole_list_persons`, `beebole_get_person`, `beebole_add_person`
   - Horas: `beebole_list_time_records`, `beebole_count_time_records`,
     `beebole_add_time_record`, `beebole_edit_time_record`,
     `beebole_delete_time_records`, `beebole_clone_time_records`
   - Timesheets: `beebole_submit_timesheet`, `beebole_approve_timesheet`, `beebole_reject_timesheet`
   - Catálogos: `beebole_list_tags`, `beebole_list_absence_types`
   - Informes: `beebole_list_reports`, `beebole_run_report`, `beebole_planned_vs_real`
2. **¿No hay tool curada?** Entonces el patrón de descubrimiento:
   `beebole_search_schema "<palabra clave>"` → `beebole_describe_operation "<nombre>"`
   (para ver argumentos y tipos exactos) → `beebole_graphql` con la query/mutation.
   No inventes nombres de operación: descúbrelos siempre con search→describe primero.

## Gotchas de dominio (la causa nº1 de fallos)

Interioriza esto antes de escribir/leer datos; el schema no perdona:

- **Duración de un fichaje = ENTERO en MINUTOS.** 1 h 30 min → `90`. Nunca horas
  decimales (`1.5`) ni segundos. Si el usuario dice "2 horas", envía `120`.
- **Timestamps = `BeeboleTimestamp` en MILISEGUNDOS** (epoch · 13 dígitos, `> 1e10`).
  Una fecha en segundos (10 dígitos) se interpretará mal. Multiplica ×1000.
- **Crear proyecto o tarea exige categoría:** `beebole_add_project` / `beebole_add_task`
  requieren `categoryId` (o `parentId` para anidar). Sin ello la API rechaza con
  `NoCategoryOrParentProvided`. Si no la tienes, descúbrela primero
  (`search_schema "categor"` → describe → query de categorías) y pásala.
- **Estados (`status`):** `d`=borrador, `s`=enviado, `a`=aprobado, `r`=rechazado.
- **Color:** índice de paleta `0–71`. **Ausencias:** unidad `day` o `hour`.

## Patrones frecuentes

- **Fichar horas:** `beebole_add_time_record` con persona, tarea/proyecto, fecha
  (ms) y `duration` en minutos. Confirma persona y proyecto con un `list_*` si hay duda.
- **Horas por proyecto / rentabilidad:** primero `beebole_list_reports` para ver
  los informes definidos; ejecuta con `beebole_run_report`. Para previsto vs. real,
  `beebole_planned_vs_real`. Estos informes son la vía correcta para analítica, no
  sumar fichajes a mano.
- **Aprobar partes:** `submit` → `approve`/`reject`. Comprueba el estado antes.
- **Borrados:** son destructivos y normalmente sin papelera. Antes de
  `delete_time_records`, resume al usuario qué se va a borrar y pide confirmación.

## Antes de operar

- Si una llamada devuelve un error de permisos o vacío inesperado, lo más probable
  es **API key inválida o sin permisos** para ese recurso, no un bug del MCP.
- Verifica identidad con `beebole_whoami` si dudas de con qué usuario actúas (el
  MCP actúa siempre como el dueño de la API key configurada).
