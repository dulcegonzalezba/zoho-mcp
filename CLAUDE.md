# CLAUDE.md

Este archivo proporciona orientación a Claude Code (claude.ai/code) cuando trabaja con el código de este repositorio.

## Propósito del Proyecto

Servidor MCP (Model Context Protocol) que conecta Zoho Projects con Claude AI. Expone operaciones de Zoho Projects como herramientas MCP invocables por Claude, permitiendo gestión de proyectos/tareas, seguimiento de tiempo y manejo de comentarios a través de una interfaz MCP basada en stdio.

## Comandos

```bash
npm run setup       # Autenticación OAuth2 inicial — abre el navegador, inicia servidor de callback en localhost:8080, guarda tokens.json
npm start           # Inicia el servidor MCP (transporte stdio)
npm run team-tasks  # Lista tareas abiertas de los miembros del equipo (emails hardcodeados)
npm run my-mentions # Lista menciones al usuario en comentarios (todos los proyectos o uno específico)
npm run aprobar-horas # Aprueba las horas pendientes del equipo en un mes y genera el informe (MD + HTML + PDF)
```

No hay paso de compilación ni pruebas — el proyecto corre directamente como módulos ES.

## Arquitectura

Tres archivos fuente con separación clara de responsabilidades:

- **`src/server.js`** — Punto de entrada del servidor MCP. Al arrancar llama a `GET /api/v3/portals` para resolver el nombre del portal (`ZOHO_PORTAL_NAME`) a su ID numérico requerido por V3, y lo almacena en la variable `PORTAL`. Registra las 13 herramientas con esquemas de parámetros Zod y delega cada una a `zohoClient`.
- **`src/zoho-client.js`** — Cliente HTTP singleton para la API REST de Zoho Projects (`https://projectsapi.zoho.com/api/v3`). Carga los tokens desde `tokens.json`, refresca automáticamente en respuesta 401 y reintenta la solicitud original una vez. Los cuerpos de solicitud usan `application/json`.
- **`src/setup-auth.js`** — Configuración OAuth2 de una sola vez: abre la URL de autorización, recibe el código via servidor HTTP local en el puerto 8080, lo intercambia por tokens y escribe `tokens.json`.

### Scripts utilitarios (`scripts/`)

Utilidades independientes que no forman parte del servidor MCP. Todas usan `zohoClient` directamente y requieren `.env`.

**`scripts/my-open-tasks.js`** — `npm run team-tasks`
Lista todas las tareas abiertas asignadas a miembros del equipo SIGOB en todos los proyectos del portal. Los emails y fragmentos de nombre del equipo están hardcodeados en el archivo.

**`scripts/auto-timer.js`** — `npm run timer:start` / `npm run timer:stop`
Inicia o detiene el timer en la tarea definida por `ZOHO_AUTO_TIMER_PROJECT_ID` y `ZOHO_AUTO_TIMER_TASK_ID`. Pensado para ejecutarse desde un cron en Railway (ver README). No requiere `tokens.json`; funciona solo con `ZOHO_REFRESH_TOKEN` en el entorno.

**`scripts/my-mentions.js`** — `npm run my-mentions`
Lista todos los comentarios donde se menciona al usuario (`ZOHO_MY_USER_ID`). Detecta menciones en formato Zoho (`[~ID]`) y opcionalmente por nombre (`ZOHO_MY_NAME`). Soporta filtro por rango de fechas.

```bash
npm run my-mentions                                        # todos los proyectos
npm run my-mentions -- "sigob-sir-lite"                   # un proyecto específico
npm run my-mentions -- --from=2026-05-01 --to=2026-06-09 # con rango de fechas
npm run my-mentions -- "sigob-sir-lite" --from=2026-06-01
```

Variable de entorno opcional: `ZOHO_MY_NAME` — si se define (ej: `"Francisco Gomez"`), amplía la detección de menciones por nombre además de por ID.

**`scripts/aprobar-horas.js`** — `npm run aprobar-horas`
Aprueba en lote los registros de horas pendientes de un equipo en un mes y genera el informe con marca SIGOB (`.md`, `.html` y `.pdf`).

```bash
npm run aprobar-horas                                    # mes anterior, equipo del .env
npm run aprobar-horas -- --month=2026-08                 # un mes específico
npm run aprobar-horas -- --month=2026-08 --dry-run       # lista lo pendiente sin aprobar nada
npm run aprobar-horas -- --team="ana@x.com,beto@x.com"   # otro equipo, sin tocar el .env
npm run aprobar-horas -- --team="ana lopez,beto" --team-name="Equipo Backend"
npm run aprobar-horas -- --help
```

El equipo es **configurable**, no está hardcodeado: sale de `ZOHO_APPROVAL_TEAM` en `.env` y `--team` lo sobrescribe. Acepta emails (match exacto) o fragmentos de nombre (todas las palabras deben aparecer). Filtrar por email es más confiable: en el portal los nombres tienen grafías inconsistentes.

Salida: `docs/informes-horas/<YYYY-MM>-<EQUIPO>.{md,html,pdf}` (o la carpeta que indique `--out=DIR`). El PDF necesita `assets/sigob-5.png` para la portada.

## Organización de documentos

Los documentos generados viven en `docs/`, agrupados **por tipo** y dentro **por proyecto**. El índice completo, con convenciones de nombres y el contenido actual, está en **`docs/README.md`** — consúltalo antes de crear un documento nuevo para respetar dónde va y cómo se llama.

```
docs/liberaciones/<PROYECTO>/<fecha>.{md,html,pdf}
docs/informes-horas/<YYYY-MM>-<EQUIPO>.{md,html,pdf}
docs/analisis/<PROYECTO|general>/
docs/backlogs/<PROYECTO>/
docs/calidad/<PROYECTO>/
docs/guias/
assets/sigob-5.png          logo de portada (los HTML lo referencian relativo)
work/                       JSON de trabajo, backups, previews — en .gitignore
```

Regla: **un documento = tres archivos** con el mismo nombre base (`.md` fuente, `.html` maquetado, `.pdf` para compartir), fechas en ISO, y sufijo `Ver.XXXX` solo cuando hay varias versiones del PDF.

## Autenticación y Configuración

`.env` contiene:
- `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET` — credenciales OAuth de la app Zoho
- `ZOHO_PORTAL_NAME` — nombre del portal (ej: `sigobproyectos`); el servidor lo resuelve automáticamente a ID numérico al arrancar via `GET /api/v3/portals`
- `ZOHO_MY_USER_ID` — zpuid del usuario por defecto para asignación automática en `create_task` (obtenerlo con `list_users` en cualquier proyecto)
- `ZOHO_MY_NAME` — nombre completo del usuario (opcional); usado por `my-mentions` para detectar menciones por nombre
- `ZOHO_TEAM_EMAILS` — emails del equipo separados por comas; usado por `team-tasks` (ej: `user1@empresa.com,user2@empresa.com`)
- `ZOHO_TEAM_NAMES` — fragmentos de nombre separados por comas para detectar miembros por nombre (ej: `jose ramon,tejeda,kevin`)
- `ZOHO_AUTO_TIMER_PROJECT_ID` — ID numérico del proyecto para el timer automático (`auto-timer.js`)
- `ZOHO_AUTO_TIMER_TASK_ID` — ID numérico de la tarea objetivo del timer automático
- `ZOHO_APPROVAL_TEAM` — emails (o fragmentos de nombre) del equipo cuyas horas se aprueban con `aprobar-horas`, separados por comas
- `ZOHO_APPROVAL_TEAM_NAME` — nombre del equipo que aparece en el informe (ej: `LIDERES Y QA FSW`)
- `ZOHO_HOURS_PER_WEEK` — jornada de referencia para el informe de horas (default: `45`)
- `ZOHO_REFRESH_TOKEN` — refresh token OAuth; reemplaza a `tokens.json` en Railway/entornos sin filesystem persistente

`tokens.json` (generado por `npm run setup`) almacena los tokens OAuth activos incluyendo el refresh token. Ambos archivos están en `.gitignore` y son requeridos en tiempo de ejecución.

El refresco de tokens es transparente: `zoho-client.js` reintenta cualquier 401 automáticamente con un token de acceso nuevo y luego persiste el nuevo token en disco.

## Herramientas MCP Expuestas

`list_projects`, `list_tasks`, `get_task`, `create_task`, `update_task`, `list_comments`, `add_comment`, `list_users`, `start_timer`, `stop_timer`, `list_task_fields`, `list_timelogs`, `approve_timelogs`. Todas las herramientas reciben `project_id` como parámetro requerido, excepto `list_projects`.

### Creación rápida de tareas (`create_task`)

- `project_id` acepta nombre o ID numérico (ej: `"sigob-sir-lite"` o `"123456"`)
- ⚠️ **`hours` es obligatorio.** Ninguna tarea debe darse de alta sin horas asignadas, en ningún proyecto. Acepta `"6"` o `"06:00"`; rechaza `0` y formatos inválidos. Si no se conoce la estimación, hay que preguntarla antes de crear la tarea, no dejarla en cero.
- Si no se especifica `person_responsible`, se asigna automáticamente el usuario en `ZOHO_MY_USER_ID`
- Campos disponibles: `name`, `description`, `priority` (lowercase: `high/medium/low/none`), `start_date`, `due_date` (formato MM-DD-YYYY, se convierte a ISO internamente), `tasklist_id`, `custom_fields`
- `start_date` es **requerida por la API de Zoho**; si no se proporciona, el servidor usa la fecha de hoy automáticamente
- Para campos personalizados usar `list_task_fields` para obtener los `api_name` y pasarlos en `custom_fields` como `{"cf_area_tecnica": "Backend"}`
- `description` se convierte automáticamente a HTML antes de enviarse a Zoho (ver abajo); si ya contiene HTML se envía tal cual

### Formato HTML automático de descripciones

La función `toHtmlDescription` en `server.js` convierte texto plano a HTML estructurado para `create_task` y `update_task`:

- Líneas en **MAYÚSCULAS** → `<h3>TÍTULO</h3><br><br>`
- Líneas con `-`, `*` o `•` → `<ul><li>...</li></ul>`
- Resto de líneas → `<p>texto</p>`
- Si la descripción ya contiene etiquetas HTML, se pasa sin modificar

### Horas de tareas (`owners_and_work`)

Zoho **acepta** el campo `work: "6:00"` pero lo guarda como `00:00`. La única forma que persiste las horas es:

```json
"owners_and_work": {
  "work_type": "standard",
  "unit": "hours",
  "total_work": "06:00",
  "owners": [{ "zpuid": "1065990000...", "work_values": "06:00" }]
}
```

Las horas y el propietario viven en el mismo objeto: al cambiar uno hay que reenviar el otro o se borra. `update_task` lo maneja releyendo la tarea antes del `PATCH`. Tras crear, `create_task` reconsulta la tarea y devuelve una advertencia explícita si `total_work` quedó en `00:00`.

Las subtareas se crean por el endpoint V2 (`/restapi/.../subtasks/`), que **no** acepta horas: hay que setearlas con un `PATCH` V3 inmediatamente después de crearlas.

## API Zoho Projects V3 — Notas de Migración

El proyecto fue migrado de la API V2 (`/restapi/`) a V3 (`/api/v3/`) en junio 2026. El soporte de V2 terminó en diciembre 2025.

### Diferencias clave V2 → V3

| Aspecto | V2 | V3 |
|---|---|---|
| Base URL | `/restapi/portal/{name}/...` | `/api/v3/portal/{id}/...` |
| Content-Type | `application/x-www-form-urlencoded` | `application/json` |
| Portal identificador | Nombre (ej: `sigobproyectos`) | **ID numérico** (ej: `739121528`) |
| HTTP update | `PUT` | `PATCH` |
| Trailing slash | Requerido | **No usar** |
| Fechas | `MM-DD-YYYY` | ISO 8601 completo: `YYYY-MM-DDTHH:mm:ss.SSSZ` |
| Task owner | `person_responsible: "id"` | `owners_and_work: { owners: [{ zpuid: "id" }] }` |
| Task ID field | `id_string` | `id` |
| Task owners en response | `details.owners[]` | `owners_and_work.owners[]` |
| Status en update | String `"Open"` | Objeto `{ id: "..." }` o `{ name: "..." }` |
| Custom fields | `UDF_CHAR1`, `UDF_LONG2` | `api_name` (ej: `cf_area_tecnica`) |
| get_task response | `{ tasks: [task] }` | Task object directo |
| create_task response | `{ tasks: [task] }` | Task object directo |
| Comentario (campo body) | `content` | `comment` |
| Comentario autor en response | `posted_by.name` / `added_by` | `created_by.name` |
| add_comment response | `{ comments: [...] }` | Array directo `[{...}]` |

### Timer V3

El endpoint de timer cambió completamente:
- **Start**: `POST /api/v3/portal/{id}/timelogs/timers` con body `{ entity_id, project_id, module_id }` — el `module_id` se obtiene dinámicamente de `GET /projects/{id}/modules` buscando `module_name === "Task"`
- **Stop**: Dos pasos — `GET /timelogs/timers` para obtener el timer ID activo, luego `PATCH /timelogs/timers/{id}/stop`. Zoho descarta automáticamente timers de menos de 30 segundos.
- **Get running**: `GET /api/v3/portal/{id}/timelogs/timers?type=task`
- La path `(timesheet|timelogs)` en los docs significa que ambas palabras funcionan; usamos `timelogs`

### Timelogs y aprobación de horas

**Listar:** `GET /api/v3/portal/{id}/timelogs?module={"type":"task"}&start_date=YYYY-MM-DD&per_page=100&page=N`

- `module` va como **JSON** con campo `type`. Valores válidos: **`task`, `issue`, `general`**. Hay que barrer los tres o se pierden horas en silencio (`bug`, `all`, `milestone` dan `PATTERN_NOT_MATCHED`; V3 dice `issue` donde V2 dice `bug`).
- ⚠️ **`end_date` se ignora**: la API devuelve la **semana ISO (lun–dom) que contiene `start_date`**. Para cubrir un mes hay que consultar el lunes de cada semana involucrada.
- ⚠️ **`page_info.has_next_page` viene siempre `true`** y `page_count` siempre `100`. El corte real es "esta página ya no aportó ids nuevos" (dedupe por `log.id`).
- Encadenar cientos de llamadas produce `fetch failed` esporádico: reintentar con backoff.

**Aprobar:** V3 **no expone ruta de aprobación**. Solo existe en V2, form-encoded y **un log por llamada** (no hay endpoint de lote):

```
POST /restapi/portal/{id}/projects/{proj}/tasks/{taskId}/logs/{logId}/approval
POST /restapi/portal/{id}/projects/{proj}/bugs/{issueId}/logs/{logId}/approval   # type: issue
POST /restapi/portal/{id}/projects/{proj}/logs/{logId}/approval                  # type: general
body: approval=approve|pending|reject  (+ reason si reject)
```

⚠️ Esta ruta va **SIN slash final**, al revés del resto de V2; con slash devuelve `{"code":6891,"message":"Given URL is wrong"}`. La documentación oficial de Zoho muestra la variante con slash y está equivocada.

La operación es reversible: el mismo endpoint con `approval=pending` devuelve el registro a pendiente.

### Respuesta de proyectos

`GET /api/v3/portal/{id}/projects` devuelve un **array directo** `[{...}]`, no `{ projects: [...] }`. El código usa `Array.isArray(r) ? r : (r.projects || [])` para manejar ambos formatos.

El objeto proyecto en V3 tiene `status` como objeto `{ id, name, color, is_closed_type }`, no string.

### Portal ID numérico

V3 requiere ID numérico del portal en todas las rutas. El servidor resuelve esto automáticamente al arrancar:

```
GET /api/v3/portals  →  [ { portal_name: "sigobproyectos", id: "123456789", ... } ]
```

La función `initPortalId()` en `server.js` busca el portal por `portal_name`, `org_name` o `name` y actualiza la variable `PORTAL` con el ID numérico antes de aceptar cualquier tool call. Si `ZOHO_PORTAL_NAME` ya es numérico, se usa directamente sin llamar al endpoint.
