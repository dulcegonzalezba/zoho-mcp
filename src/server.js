import { config } from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env") });

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { zohoClient } from "./zoho-client.js";

const PORTAL_NAME = process.env.ZOHO_PORTAL_NAME || "sigobproyectos";
const server = new McpServer({ name: "Zoho Projects", version: "1.0.0" });

const text = (str) => ({ content: [{ type: "text", text: String(str) }] });
const toZpuid = (id) => (id != null ? String(id).trim() : "") || undefined;

let PORTAL = PORTAL_NAME;

async function initPortalId() {
  if (/^\d+$/.test(PORTAL_NAME)) return;
  const portals = await zohoClient.get("/portals");
  const list = Array.isArray(portals) ? portals : (portals.portals || []);
  const match = list.find(p =>
    p.portal_name === PORTAL_NAME ||
    p.org_name === PORTAL_NAME ||
    p.name === PORTAL_NAME
  );
  if (match?.id) PORTAL = String(match.id);
}

async function resolveProjectId(nameOrId) {
  if (/^\d+$/.test(nameOrId)) return nameOrId;
  const r = await zohoClient.get(`/portal/${PORTAL}/projects`);
  const list = Array.isArray(r) ? r : (r.projects || []);
  const match = list.find(p =>
    p.name.toLowerCase() === nameOrId.toLowerCase() ||
    p.name.toLowerCase().includes(nameOrId.toLowerCase())
  );
  if (!match) throw new Error(`No se encontró proyecto con nombre: "${nameOrId}"`);
  return match.id;
}

function toISODate(mmddyyyy) {
  if (!mmddyyyy) return undefined;
  const [m, d, y] = mmddyyyy.split("-");
  return `${y}-${m}-${d}T00:00:00.000Z`;
}

// Normaliza "6", "6:00" o "06:00" a "06:00". Lanza si el valor es cero o inválido:
// ninguna tarea debe darse de alta sin horas asignadas.
function toWorkHours(hours) {
  const raw = String(hours ?? "").trim();
  const m = raw.match(/^(\d{1,3})(?::([0-5]\d))?$/);
  if (!m) {
    throw new Error(`Horas inválidas: "${raw}". Usa el formato "H" o "HH:MM" (ej: "6" o "06:00").`);
  }
  const h = Number(m[1]);
  const min = m[2] ?? "00";
  if (h === 0 && min === "00") {
    throw new Error("Las horas no pueden ser 00:00. Toda tarea debe crearse con horas asignadas.");
  }
  return `${String(h).padStart(2, "0")}:${min}`;
}

// Zoho acepta `work: "6:00"` pero lo guarda como 00:00. La única forma que persiste
// las horas es owners_and_work con total_work + work_values por propietario.
function buildOwnersAndWork(zpuid, workHours) {
  return {
    work_type: "standard",
    unit: "hours",
    total_work: workHours,
    owners: zpuid ? [{ zpuid, work_values: workHours }] : [],
  };
}

function toHtmlDescription(text) {
  if (!text) return text;
  if (/<[a-z][\s\S]*>/i.test(text)) return text;

  const lines = text.split("\n");
  const out = [];
  let listItems = [];

  const flushList = () => {
    if (!listItems.length) return;
    out.push(`<ul>${listItems.map(i => `<li>${i}</li>`).join("")}</ul>`);
    listItems = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushList(); continue; }

    if (/^[-*•]\s+/.test(line)) {
      listItems.push(line.replace(/^[-*•]\s+/, ""));
      continue;
    }

    flushList();

    // Heading: all-caps line (optionally ending with :), at least 3 chars
    if (/^[A-ZÁÉÍÓÚÜÑ0-9\s,.()\-_:]{3,}$/.test(line) && line === line.toUpperCase()) {
      out.push(`<h3>${line.replace(/:$/, "")}</h3><br><br>`);
    } else {
      out.push(`<p>${line}</p>`);
    }
  }

  flushList();
  return out.join("");
}

// ── list_projects ────────────────────────────────────────────────────────────
server.tool("list_projects", "Lista todos los proyectos del portal", {}, async () => {
  const r = await zohoClient.get(`/portal/${PORTAL}/projects`);
  const projects = Array.isArray(r) ? r : (r.projects || []);
  if (!projects.length) return text("No se encontraron proyectos.");
  return text(projects.map(p =>
    `ID: ${p.id} | Nombre: ${p.name} | Estado: ${p.status?.name || p.status || "N/A"}`
  ).join("\n"));
});

// ── list_tasks ────────────────────────────────────────────────────────────────
server.tool(
  "list_tasks",
  "Lista las tareas de un proyecto",
  {
    project_id: z.string().describe("ID del proyecto"),
    status: z.string().optional().describe('Filtro: "open", "closed", "overdue"'),
  },
  async ({ project_id, status }) => {
    const params = {};
    if (status) params.filter = JSON.stringify({ criteria: [{ field_name: "status", criteria_condition: "is", value: status }], pattern: "1" });
    const r = await zohoClient.get(`/portal/${PORTAL}/projects/${project_id}/tasks`, params);
    const tasks = r.tasks || [];
    if (!tasks.length) return text("No se encontraron tareas.");
    return text(tasks.map(t => {
      const owners = (t.owners_and_work?.owners || []).map(o => o.name).join(", ") || "Sin asignar";
      return `ID: ${t.id} | ${t.name} | Estado: ${t.status?.name || "N/A"} | Prioridad: ${t.priority || "N/A"} | Asignado: ${owners}`;
    }).join("\n"));
  }
);

// ── get_task ──────────────────────────────────────────────────────────────────
server.tool(
  "get_task",
  "Obtiene el detalle completo de una tarea",
  {
    project_id: z.string().describe("ID del proyecto"),
    task_id: z.string().describe("ID de la tarea"),
  },
  async ({ project_id, task_id }) => {
    const t = await zohoClient.get(`/portal/${PORTAL}/projects/${project_id}/tasks/${task_id}`);
    if (!t?.id) return text("Tarea no encontrada.");
    const owners = (t.owners_and_work?.owners || []).map(o => o.name).join(", ") || "Sin asignar";
    return text([
      `Nombre:      ${t.name}`,
      `ID:          ${t.id}`,
      `Estado:      ${t.status?.name || "N/A"}`,
      `Prioridad:   ${t.priority || "N/A"}`,
      `Asignado a:  ${owners}`,
      `Fecha límite:${t.end_date ? t.end_date.slice(0, 10) : "Sin fecha"}`,
      `Descripción: ${t.description || "Sin descripción"}`,
    ].join("\n"));
  }
);

// ── create_task ───────────────────────────────────────────────────────────────
server.tool(
  "create_task",
  "Crea una nueva tarea. Acepta nombre o ID de proyecto. Las horas (hours) son OBLIGATORIAS: ninguna tarea debe darse de alta sin horas asignadas. Defaults automáticos si no se especifican: propietario=ZOHO_MY_USER_ID, revisor=ZOHO_MY_USER_ID, revisor_de_desarrollo=ZOHO_MY_USER_ID, tamaño=3.",
  {
    project_id:         z.string().describe("ID numérico o nombre del proyecto (ej: 'sigob-sir-lite')"),
    name:               z.string().describe("Nombre de la tarea"),
    hours:              z.string().describe("OBLIGATORIO. Horas estimadas en formato 'H' o 'HH:MM' (ej: '6' o '06:00'). No se acepta 0. Si no conoces la estimación, pregúntala antes de crear la tarea."),
    description:        z.string().optional().describe("Descripción"),
    priority:           z.enum(["high", "medium", "low", "none"]).optional(),
    person_responsible: z.string().optional().describe("ID (zpuid) del usuario responsable (por defecto: ZOHO_MY_USER_ID del .env)"),
    start_date:         z.string().optional().describe("Fecha de inicio MM-DD-YYYY (requerida por Zoho; por defecto: hoy)"),
    due_date:           z.string().optional().describe("Fecha de vencimiento MM-DD-YYYY"),
    tasklist_id:        z.string().optional().describe("ID de la lista de tareas"),
    custom_fields:      z.record(z.string()).optional().describe("Campos personalizados por api_name (ej: {cf_area_tecnica: 'Backend'})"),
  },
  async ({ project_id, name, hours, description, priority, person_responsible, start_date, due_date, tasklist_id, custom_fields }) => {
    const resolvedId = await resolveProjectId(project_id);
    const responsible = toZpuid(person_responsible || process.env.ZOHO_MY_USER_ID);
    const workHours = toWorkHours(hours);

    const body = { name };
    if (description) body.description = toHtmlDescription(description);
    if (priority)    body.priority = priority;
    body.owners_and_work = buildOwnersAndWork(responsible, workHours);
    const effectiveStartDate = start_date || new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" }).replace(/\//g, "-");
    body.start_date = toISODate(effectiveStartDate);
    if (due_date)    body.end_date = toISODate(due_date);
    if (tasklist_id) body.tasklist = { id: tasklist_id };
    if (custom_fields) {
      for (const [key, val] of Object.entries(custom_fields)) {
        // Quote large integers in zpuid fields before parsing to preserve 18-digit precision
        const safe = val.replace(/"zpuid"\s*:\s*(\d{15,})/g, '"zpuid":"$1"');
        try { body[key] = JSON.parse(safe); } catch { body[key] = val; }
      }
    }

    const myId = toZpuid(process.env.ZOHO_MY_USER_ID);
    if (myId) {
      if (!body.revisor)              body.revisor              = { zpuid: myId };
      if (!body.revisor_de_desarrollo) body.revisor_de_desarrollo = { zpuid: myId };
    }
    if (!body.tamano_de_tarea_1_facil_5_dificil) body.tamano_de_tarea_1_facil_5_dificil = "3";

    const t = await zohoClient.post(`/portal/${PORTAL}/projects/${resolvedId}/tasks`, body);
    if (!t?.id) return text(`Respuesta: ${JSON.stringify(t)}`);

    // Zoho puede aceptar el body y aun así no persistir las horas: reconfirmar contra la tarea guardada.
    const saved = await zohoClient.get(`/portal/${PORTAL}/projects/${resolvedId}/tasks/${t.id}`);
    const savedWork = saved?.owners_and_work?.total_work;
    if (!savedWork || savedWork === "00:00") {
      return text(
        `Tarea creada CON ADVERTENCIA.\nID: ${t.id} | Nombre: ${t.name}\n` +
        `⚠️ Las horas quedaron en "${savedWork || "vacío"}" en lugar de ${workHours}. ` +
        `Corrígelas con update_task (hours) antes de darla por dada de alta.`
      );
    }
    return text(`Tarea creada.\nID: ${t.id} | Nombre: ${t.name} | Horas: ${savedWork}`);
  }
);

// ── update_task ───────────────────────────────────────────────────────────────
server.tool(
  "update_task",
  "Actualiza una tarea existente (estado, prioridad, responsable, etc.)",
  {
    project_id:        z.string().describe("ID del proyecto"),
    task_id:           z.string().describe("ID de la tarea"),
    name:              z.string().optional().describe("Nuevo nombre"),
    description:       z.string().optional().describe("Nueva descripción"),
    status:            z.string().optional().describe("ID numérico del estado, o nombre: 'Open', 'Closed'"),
    priority:          z.enum(["high", "medium", "low", "none"]).optional(),
    person_responsible:z.string().optional().describe("zpuid del usuario responsable"),
    hours:             z.string().optional().describe("Horas estimadas en formato 'H' o 'HH:MM' (ej: '6' o '06:00'). No se acepta 0."),
    due_date:          z.string().optional().describe("Fecha límite MM-DD-YYYY"),
  },
  async ({ project_id, task_id, name, description, status, priority, person_responsible, hours, due_date }) => {
    const body = {};
    if (name)              body.name = name;
    if (description)       body.description = toHtmlDescription(description);
    if (status)            body.status = /^\d+$/.test(status) ? { id: status } : { name: status };
    if (priority)          body.priority = priority;
    if (due_date)          body.end_date = toISODate(due_date);

    // Las horas viven dentro de owners_and_work, así que un cambio de horas o de
    // propietario tiene que reenviar ambos datos para no borrar el otro.
    if (hours || person_responsible) {
      const current = await zohoClient.get(`/portal/${PORTAL}/projects/${project_id}/tasks/${task_id}`);
      const currentWork = current?.owners_and_work?.total_work;
      if (!hours && (!currentWork || currentWork === "00:00")) {
        throw new Error(
          `La tarea ${task_id} no tiene horas asignadas (${currentWork || "vacío"}). ` +
          `Incluye el parámetro hours en esta actualización para dejarla en regla.`
        );
      }
      const workHours = hours ? toWorkHours(hours) : toWorkHours(currentWork);
      const zpuid = person_responsible
        ? toZpuid(person_responsible)
        : current?.owners_and_work?.owners?.[0]?.zpuid;
      body.owners_and_work = buildOwnersAndWork(zpuid, workHours);
    }

    if (!Object.keys(body).length) return text("No se proporcionaron campos para actualizar.");

    const t = await zohoClient.patch(`/portal/${PORTAL}/projects/${project_id}/tasks/${task_id}`, body);
    if (t?.id) return text(`Tarea actualizada.\nID: ${t.id} | Nombre: ${t.name} | Estado: ${t.status?.name || "N/A"}`);
    return text(`Respuesta: ${JSON.stringify(t)}`);
  }
);

// ── list_comments ─────────────────────────────────────────────────────────────
server.tool(
  "list_comments",
  "Lista los comentarios de una tarea",
  {
    project_id: z.string().describe("ID del proyecto"),
    task_id:    z.string().describe("ID de la tarea"),
  },
  async ({ project_id, task_id }) => {
    const r = await zohoClient.get(`/portal/${PORTAL}/projects/${project_id}/tasks/${task_id}/comments`);
    const comments = r.comments || [];
    if (!comments.length) return text("No hay comentarios en esta tarea.");
    return text(comments.map(c => `[${c.created_by?.name || "Desconocido"}]: ${c.comment || ""}`).join("\n---\n"));
  }
);

// ── add_comment ───────────────────────────────────────────────────────────────
server.tool(
  "add_comment",
  "Agrega un comentario a una tarea",
  {
    project_id: z.string().describe("ID del proyecto"),
    task_id:    z.string().describe("ID de la tarea"),
    content:    z.string().describe("Texto del comentario"),
  },
  async ({ project_id, task_id, content }) => {
    const r = await zohoClient.post(
      `/portal/${PORTAL}/projects/${project_id}/tasks/${task_id}/comments`,
      { comment: content }
    );
    if (Array.isArray(r) && r.length) return text("Comentario agregado exitosamente.");
    return text(`Respuesta: ${JSON.stringify(r)}`);
  }
);

// ── list_users ────────────────────────────────────────────────────────────────
server.tool(
  "list_users",
  "Lista los usuarios de un proyecto",
  {
    project_id: z.string().describe("ID del proyecto"),
  },
  async ({ project_id }) => {
    const resolvedId = await resolveProjectId(project_id);
    const r = await zohoClient.get(`/portal/${PORTAL}/projects/${resolvedId}/users`);
    const users = r.users || [];
    if (!users.length) return text("No se encontraron usuarios.");
    return text(users.map(u =>
      `zpuid: ${u.zpuid || u.id || "N/A"} | Nombre: ${u.full_name || u.name || "N/A"} | Email: ${u.email || "N/A"} | Rol: ${u.role?.name || u.role || "N/A"}`
    ).join("\n"));
  }
);

// ── start_timer ───────────────────────────────────────────────────────────────
server.tool(
  "start_timer",
  "Inicia el timer de seguimiento de tiempo en una tarea",
  {
    project_id: z.string().describe("ID del proyecto"),
    task_id:    z.string().describe("ID de la tarea"),
    notes:      z.string().optional().describe("Notas del registro"),
  },
  async ({ project_id, task_id, notes }) => {
    const modulesRes = await zohoClient.get(`/portal/${PORTAL}/projects/${project_id}/modules`);
    const modules = modulesRes.modules || [];
    const taskModule = modules.find(m => m.module_name === "Task");
    if (!taskModule) return text("No se encontró el módulo de tareas en este proyecto.");
    const body = { entity_id: task_id, project_id, module_id: taskModule.module_id };
    if (notes) body.notes = notes;
    const r = await zohoClient.post(`/portal/${PORTAL}/timelogs/timers`, body);
    if (r.timer || r.id) return text("Timer iniciado.");
    return text(`Respuesta: ${JSON.stringify(r)}`);
  }
);

// ── stop_timer ────────────────────────────────────────────────────────────────
server.tool(
  "stop_timer",
  "Detiene el timer de una tarea",
  {
    project_id: z.string().describe("ID del proyecto"),
    task_id:    z.string().describe("ID de la tarea"),
  },
  async ({ project_id, task_id }) => {
    const timersRes = await zohoClient.get(`/portal/${PORTAL}/timelogs/timers`, { type: "task" });
    const timers = timersRes.timer || [];
    const active = timers.find(t => t.project?.project_id === project_id) ?? timers[0];
    if (!active) return text("No se encontró un timer activo para esta tarea.");
    const today = new Date().toISOString().slice(0, 10);
    const r = await zohoClient.patch(`/portal/${PORTAL}/timelogs/timers/${active.id}/stop`, {
      type: "task",
      date: today,
      bill_status: "Non Billable",
      project_id,
    });
    if (r?.error?.details?.[0]?.message_key === "zero_hour_restriction")
      return text("Timer detenido pero descartado: duración menor a 30 segundos (regla de Zoho).");
    if (r?.error) return text(`Error al detener timer: ${JSON.stringify(r.error)}`);
    return text(`Timer detenido. Tiempo registrado: ${active.time_spent || "N/A"}`);
  }
);

// ── list_task_fields ──────────────────────────────────────────────────────────
server.tool(
  "list_task_fields",
  "Lista los campos disponibles en las tareas de un proyecto (incluidos custom fields), con su api_name para usar en create_task",
  {
    project_id: z.string().describe("ID o nombre del proyecto"),
  },
  async ({ project_id }) => {
    const resolvedId = await resolveProjectId(project_id);
    const myUserId = toZpuid(process.env.ZOHO_MY_USER_ID);
    if (!myUserId) return text("ZOHO_MY_USER_ID no está definido en .env");
    const r = await zohoClient.get(
      `/portal/${PORTAL}/projects/${resolvedId}/users/${myUserId}/fields/permissions`,
      { modules: "tasks" }
    );
    const fields = Array.isArray(r)
      ? r
      : (r[myUserId] ?? Object.values(r).find(v => Array.isArray(v)) ?? []);
    if (!fields.length) return text(`Sin campos. Respuesta cruda: ${JSON.stringify(r).slice(0, 500)}`);
    return text(fields.map(f =>
      `api_name: ${f.api_name || "N/A"} | label: ${f.display_name || "N/A"} | tipo: ${f.field_type || "N/A"} | oculto: ${f.is_hidden ?? "N/A"}`
    ).join("\n"));
  }
);

// ── timelogs: helpers ─────────────────────────────────────────────────────────

// GET /timelogs ignora end_date y devuelve la semana ISO que contiene start_date.
// Para cubrir un rango hay que consultar el lunes de cada semana involucrada.
function isoWeekMondays(from, to) {
  const mondayOf = (iso) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d;
  };
  const out = [];
  for (let d = mondayOf(from), end = mondayOf(to); d <= end; d.setUTCDate(d.getUTCDate() + 7)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// La API tira `fetch failed` esporádicamente cuando se le encadenan cientos de
// llamadas; reintenta con backoff en vez de abortar el barrido completo.
async function withRetry(fn, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await sleep(600 * 2 ** i);
    }
  }
  throw lastErr;
}

// Descarga los timelogs del rango [from, to] (YYYY-MM-DD), deduplicados por id.
// page_info.has_next_page viene siempre true, así que el corte real es
// "esta página ya no aportó ids nuevos".
// Tipos válidos de module.type: task, general, issue ("bug" da PATTERN_NOT_MATCHED).
async function fetchTimelogs(from, to, types = ["task", "general", "issue"]) {
  const all = new Map();
  for (const type of types) {
    for (const monday of isoWeekMondays(from, to)) {
      for (let page = 1; page <= 15; page++) {
        const r = await withRetry(() => zohoClient.get(`/portal/${PORTAL}/timelogs`, {
          module: JSON.stringify({ type }),
          start_date: monday,
          end_date: monday,
          per_page: 100,
          page,
        }));
        if (r.error) break;
        const before = all.size;
        for (const day of (r.time_logs || [])) {
          for (const log of (day.log_details || [])) all.set(log.id, log);
        }
        if (all.size === before) break;
      }
    }
  }
  return [...all.values()]
    .filter(l => l.date >= from && l.date <= to)
    .sort((a, b) => (a.owner?.name + a.date).localeCompare(b.owner?.name + b.date));
}

// Suma "HH:MM" y devuelve "HH:MM"
function sumHours(logs) {
  const mins = logs.reduce((acc, l) => {
    const [h, m] = String(l.log_hour || "0:0").split(":").map(Number);
    return acc + (h || 0) * 60 + (m || 0);
  }, 0);
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

// Filtra por fragmentos de nombre/email (case-insensitive, sin acentos)
function matchesPeople(log, people) {
  if (!people?.length) return true;
  const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const hay = norm(`${log.owner?.name} ${log.owner?.email}`);
  return people.some(p => norm(p).split(/\s+/).filter(Boolean).every(w => hay.includes(w)));
}

// V3 no expone ruta de aprobación: se usa el endpoint V2 (form-encoded).
// OJO: esta ruta V2 va SIN slash final (con slash devuelve error 6891 "Given URL is wrong").
function approvalPath(log) {
  const project = log.project?.id;
  const entity = log.module_detail?.id;
  const base = `/restapi/portal/${PORTAL}/projects/${project}`;
  if (log.type === "task") return `${base}/tasks/${entity}/logs/${log.id}/approval`;
  // V3 llama "issue" a lo que V2 expone como /bugs/
  if (log.type === "issue" || log.type === "bug") return `${base}/bugs/${entity}/logs/${log.id}/approval`;
  return `${base}/logs/${log.id}/approval`;
}

const fmtLog = (l) =>
  `${(l.approval?.status || "?").padEnd(8)} ${l.date} ${String(l.log_hour).padStart(6)} | ` +
  `${l.owner?.name} | ${l.project?.name} | ${l.module_detail?.prefix || l.type} | log_id=${l.id}`;

// ── list_timelogs ─────────────────────────────────────────────────────────────
server.tool(
  "list_timelogs",
  "Lista los registros de horas del portal en un rango de fechas, con su estado de aprobación. Permite filtrar por persona y por estado.",
  {
    from:   z.string().describe("Fecha inicial YYYY-MM-DD"),
    to:     z.string().describe("Fecha final YYYY-MM-DD"),
    people: z.array(z.string()).optional().describe('Fragmentos de nombre o email para filtrar (ej: ["haniel rojo", "mario merel"])'),
    status: z.enum(["Pending", "Approved", "Rejected", "all"]).optional().describe("Estado de aprobación a mostrar (por defecto: Pending)"),
  },
  async ({ from, to, people, status = "Pending" }) => {
    const logs = (await fetchTimelogs(from, to))
      .filter(l => matchesPeople(l, people))
      .filter(l => status === "all" || (l.approval?.status || "").toLowerCase() === status.toLowerCase());

    if (!logs.length) return text(`Sin registros ${status === "all" ? "" : `en estado "${status}" `}entre ${from} y ${to}.`);

    const byOwner = new Map();
    for (const l of logs) {
      const k = `${l.owner?.name} <${l.owner?.email}>`;
      byOwner.set(k, [...(byOwner.get(k) || []), l]);
    }
    const bloques = [...byOwner.entries()].sort().map(([owner, ls]) =>
      `\n${owner} — ${ls.length} registro(s), ${sumHours(ls)} h\n` + ls.map(l => `  ${fmtLog(l)}`).join("\n")
    );
    return text(
      `${logs.length} registro(s) entre ${from} y ${to} — total ${sumHours(logs)} h\n${bloques.join("\n")}`
    );
  }
);

// ── approve_timelogs ──────────────────────────────────────────────────────────
server.tool(
  "approve_timelogs",
  "Aprueba (o rechaza / regresa a pendiente) registros de horas en lote. Por seguridad corre en dry_run por defecto: primero muestra qué tocaría y solo aplica con dry_run=false. Requiere permiso de aprobador en el portal.",
  {
    from:    z.string().describe("Fecha inicial YYYY-MM-DD"),
    to:      z.string().describe("Fecha final YYYY-MM-DD"),
    people:  z.array(z.string()).optional().describe("Fragmentos de nombre o email; sin esto aplica a todos"),
    log_ids: z.array(z.string()).optional().describe("IDs de log específicos; si se pasan, ignora el filtro de personas"),
    action:  z.enum(["approve", "reject", "pending"]).optional().describe("Acción a aplicar (por defecto: approve)"),
    reason:  z.string().optional().describe("Motivo — obligatorio si action=reject (máx 250 caracteres)"),
    dry_run: z.boolean().optional().describe("true (por defecto) solo lista; false aplica los cambios"),
  },
  async ({ from, to, people, log_ids, action = "approve", reason, dry_run = true }) => {
    if (action === "reject" && !reason) return text("Para rechazar hay que indicar 'reason'.");

    const pendientes = (await fetchTimelogs(from, to))
      .filter(l => (l.approval?.status || "").toLowerCase() === "pending")
      .filter(l => (log_ids?.length ? log_ids.includes(String(l.id)) : matchesPeople(l, people)));

    if (!pendientes.length) return text(`No hay registros pendientes que coincidan entre ${from} y ${to}.`);

    const cabecera = `${pendientes.length} registro(s) pendientes — ${sumHours(pendientes)} h\n` +
      pendientes.map(l => `  ${fmtLog(l)}`).join("\n");

    if (dry_run) {
      return text(`${cabecera}\n\nDRY RUN: no se modificó nada. Repite con dry_run=false para aplicar "${action}".`);
    }

    const resultados = [];
    for (const l of pendientes) {
      const body = { approval: action };
      if (reason) body.reason = reason;
      const r = await withRetry(() => zohoClient.postForm(approvalPath(l), body));
      await sleep(250);
      const ok = !r?.error && (r?.timelogs || r?.timelog || r?.status === 200 || r?.status === 201);
      resultados.push(`${ok ? "OK " : "ERR"} ${l.owner?.name} ${l.date} ${l.log_hour} log=${l.id}` +
        (ok ? "" : ` → ${JSON.stringify(r).slice(0, 200)}`));
    }
    const okCount = resultados.filter(r => r.startsWith("OK")).length;
    return text(`${cabecera}\n\nAplicado "${action}": ${okCount}/${pendientes.length} correctos.\n${resultados.join("\n")}`);
  }
);

// ── start server ──────────────────────────────────────────────────────────────
await initPortalId();
const transport = new StdioServerTransport();
await server.connect(transport);
