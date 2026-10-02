import { config } from "dotenv";
import { join, dirname, resolve, relative } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, mkdirSync } from "fs";
import { execFileSync } from "child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: join(ROOT, ".env") });

const { zohoClient } = await import("../src/zoho-client.js");

// ─────────────────────────────────────────────────────────────────────────────
// Aprobación mensual de horas + informe con marca SIGOB.
//
//   npm run aprobar-horas -- --month=2026-08
//   npm run aprobar-horas -- --month=2026-08 --dry-run
//   npm run aprobar-horas -- --month=2026-08 --team="ana@x.com,beto@x.com"
//   npm run aprobar-horas -- --month=2026-08 --team="ana lopez,beto" --team-name="Equipo Backend"
//
// El equipo por defecto sale de .env (ZOHO_APPROVAL_TEAM / ZOHO_APPROVAL_TEAM_NAME);
// --team lo sobrescribe, de modo que cada líder use el suyo sin tocar el código.
// ─────────────────────────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

if (args.help) {
  console.log(`
Uso: npm run aprobar-horas -- [opciones]

  --month=YYYY-MM     Mes a procesar (por defecto: el mes anterior al actual)
  --team="a,b,c"      Personas a filtrar: emails o fragmentos de nombre.
                      Por defecto usa ZOHO_APPROVAL_TEAM del .env
  --team-name="..."   Nombre del equipo para el informe (default: ZOHO_APPROVAL_TEAM_NAME)
  --hours-per-week=45 Jornada de referencia (default: ZOHO_HOURS_PER_WEEK o 45)
  --dry-run           No aprueba nada; solo lista lo pendiente y genera el informe
  --no-report         Solo aprueba, sin generar documentos
  --out=DIR           Carpeta de salida (default: docs/informes-horas/)
`);
  process.exit(0);
}

const DRY = Boolean(args["dry-run"]);
const HORAS_SEMANA = Number(args["hours-per-week"] || process.env.ZOHO_HOURS_PER_WEEK || 45);
const HORAS_DIA = HORAS_SEMANA / 5;
// resolve(): --out relativo debe funcionar igual que absoluto (el PDF lo genera
// otro proceso con su propio cwd).
const OUT_DIR = args.out ? resolve(String(args.out)) : join(ROOT, "docs", "informes-horas");

const TEAM_NAME = String(args["team-name"] || process.env.ZOHO_APPROVAL_TEAM_NAME || "Equipo");
const TEAM_RAW = String(args.team || process.env.ZOHO_APPROVAL_TEAM || "");
const TEAM = TEAM_RAW.split(",").map(s => s.trim()).filter(Boolean);

if (!TEAM.length) {
  console.error(
    "No hay equipo configurado.\n" +
    "  Define ZOHO_APPROVAL_TEAM en .env (emails o fragmentos de nombre, separados por comas)\n" +
    "  o pásalo con --team=\"ana@x.com,beto@x.com\"."
  );
  process.exit(1);
}

// Mes por defecto: el anterior al actual
function mesPorDefecto() {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}
const MONTH = String(args.month || mesPorDefecto());
if (!/^\d{4}-\d{2}$/.test(MONTH)) {
  console.error(`Mes inválido: "${MONTH}". Usa el formato YYYY-MM.`);
  process.exit(1);
}
const [YEAR, MON] = MONTH.split("-").map(Number);
const FROM = `${MONTH}-01`;
const TO = new Date(Date.UTC(YEAR, MON, 0)).toISOString().slice(0, 10);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const mins = l => { const [h, m] = String(l.log_hour || "0:0").split(":").map(Number); return h * 60 + m; };
const dec = m => (m / 60).toFixed(2);
const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// La API tira `fetch failed` esporádicamente al encadenar cientos de llamadas.
async function retry(fn, n = 4) {
  let last;
  for (let i = 0; i < n; i++) {
    try { return await fn(); } catch (e) { last = e; await sleep(600 * 2 ** i); }
  }
  throw last;
}

async function resolvePortal() {
  const name = process.env.ZOHO_PORTAL_NAME || "sigobproyectos";
  if (/^\d+$/.test(name)) return name;
  const r = await retry(() => zohoClient.get("/portals"));
  const list = Array.isArray(r) ? r : (r.portals || []);
  const p = list.find(x => x.portal_name === name || x.org_name === name || x.name === name);
  if (!p?.id) throw new Error(`No se encontró el portal "${name}"`);
  return String(p.id);
}

// GET /timelogs ignora end_date y devuelve la semana ISO que contiene start_date.
function lunesDelRango(from, to) {
  const lunes = iso => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d;
  };
  const out = [];
  for (let d = lunes(from), fin = lunes(to); d <= fin; d.setUTCDate(d.getUTCDate() + 7)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// Tipos válidos de module.type: task, issue, general ("bug" da PATTERN_NOT_MATCHED).
// Hay que barrer los tres o se pierden horas en silencio.
const TIPOS = ["task", "issue", "general"];

async function descargarMes(portal) {
  const todos = new Map();
  for (const type of TIPOS) {
    for (const lunes of lunesDelRango(FROM, TO)) {
      // page_info.has_next_page viene siempre true: el corte real es
      // "esta página ya no aportó ids nuevos".
      for (let page = 1; page <= 20; page++) {
        const r = await retry(() => zohoClient.get(`/portal/${portal}/timelogs`, {
          module: JSON.stringify({ type }), start_date: lunes, end_date: lunes,
          per_page: 100, page,
        }));
        if (r.error) break;
        const antes = todos.size;
        for (const dia of (r.time_logs || [])) {
          for (const log of (dia.log_details || [])) todos.set(log.id, log);
        }
        if (todos.size === antes) break;
        await sleep(250);
      }
    }
  }
  return [...todos.values()].filter(l => l.date >= FROM && l.date <= TO);
}

const esDelEquipo = log => {
  const email = norm(log.owner?.email);
  const nombre = norm(log.owner?.name);
  return TEAM.some(t => {
    const q = norm(t);
    if (q.includes("@")) return email === q;
    // fragmento de nombre: todas las palabras deben aparecer
    return q.split(/\s+/).every(w => `${nombre} ${email}`.includes(w)) || email.startsWith(q);
  });
};

/** Un registro cuenta como documentado si su campo `notes` trae texto real. */
const conNota = (l) => String(l.notes ?? "").trim().length > 0;
/** Nota con contenido real, no un "avance" o un "ok" sueltos. */
const notaUtil = (l) => String(l.notes ?? "").trim().length >= 20;
/** Registro capturado el mismo día o al siguiente del día trabajado. */
const aTiempo = (l) => {
  if (!l.date || !l.created_time) return false;
  const dias = (new Date(l.created_time.slice(0, 10)) - new Date(l.date)) / 86400000;
  return dias >= 0 && dias <= 1;
};
const esAdmin = (l) => /ADMON|ADMINISTRA/i.test(l.project?.name || "");

// Aprobación en lote: PATCH /portal/{id}/logs con un array.
// OJO: `module` va como string con el tipo ("task" / "issue"). Enviarlo como
// objeto {id, type} devuelve PATTERN_NOT_MATCHED.
async function aprobarLote(portal, logs, estado = "Approved") {
  const CHUNK = 100;
  let ok = 0;
  const errores = [];
  for (let i = 0; i < logs.length; i += CHUNK) {
    const lote = logs.slice(i, i + CHUNK);
    const payload = lote.map(l => ({
      id: l.id,
      module: l.module_detail?.type || l.type,
      approval_status: estado,
    }));
    try {
      const r = await retry(() => zohoClient.patch(`/portal/${portal}/logs`, payload));
      if (r?.error) errores.push(`lote ${i / CHUNK + 1}: ${JSON.stringify(r.error).slice(0, 200)}`);
      else ok += lote.length;
    } catch (e) {
      errores.push(`lote ${i / CHUNK + 1}: ${String(e).slice(0, 120)}`);
    }
    await sleep(300);
  }
  return { ok, errores };
}

// ── Informe ──────────────────────────────────────────────────────────────────

function semanasDelMes() {
  const out = [];
  for (const lunes of lunesDelRango(FROM, TO)) {
    const dom = new Date(`${lunes}T00:00:00Z`);
    dom.setUTCDate(dom.getUTCDate() + 6);
    const fin = dom.toISOString().slice(0, 10);
    let habiles = 0;
    for (let d = new Date(`${lunes}T00:00:00Z`); d.toISOString().slice(0, 10) <= fin; d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      const dow = d.getUTCDay();
      if (iso >= FROM && iso <= TO && dow >= 1 && dow <= 5) habiles++;
    }
    out.push({ ini: lunes, fin, habiles });
  }
  return out;
}

function construirDatos(logs) {
  const porPersona = new Map();
  for (const l of logs) {
    const k = l.owner?.email || l.owner?.name || "?";
    if (!porPersona.has(k)) porPersona.set(k, { nombre: l.owner?.name || k, email: l.owner?.email || "", ls: [] });
    porPersona.get(k).ls.push(l);
  }
  // Personas del filtro que no registraron nada: se listan en cero
  for (const t of TEAM) {
    const q = norm(t);
    const existe = [...porPersona.values()].some(p => norm(p.email) === q || norm(p.nombre).includes(q));
    if (!existe) porPersona.set(t, { nombre: t, email: q.includes("@") ? t : "", ls: [], sinRegistros: true });
  }
  return [...porPersona.values()]
    .map(p => ({ ...p, tot: p.ls.reduce((a, l) => a + mins(l), 0) }))
    .sort((a, b) => b.tot - a.tot);
}

function generarMarkdown(data, semanas, meta, resumenAprobacion) {
  const gt = data.reduce((a, d) => a + d.tot, 0);
  const gn = data.reduce((a, d) => a + d.ls.length, 0);
  let md = `# Informe de horas — ${TEAM_NAME} — ${MONTH}\n\n`;
  md += `**Portal:** ${process.env.ZOHO_PORTAL_NAME} · **Periodo:** ${FROM} a ${TO} · **Generado:** ${new Date().toISOString().slice(0, 10)}\n\n`;
  md += `${resumenAprobacion}\n\n`;
  md += `## Base de comparación\n\nJornada de referencia: **${HORAS_SEMANA} h/semana = ${HORAS_DIA} h por día hábil**. `;
  md += `El periodo tiene **${semanas.reduce((a, s) => a + s.habiles, 0)} días hábiles** → meta **${meta} h**.\n\n`;
  md += `> Solo se cuentan horas registradas en Zoho en este portal, en los tres tipos de registro (\`task\`, \`issue\`, \`general\`). Vacaciones, incapacidades, festivos y trabajo no registrado no están descontados de la meta.\n\n`;
  md += `## Resumen: horas trabajadas vs. horas laborales\n\n| Persona | Registros | Horas | Meta | Diferencia | % |\n|---|---:|---:|---:|---:|---:|\n`;
  for (const d of data) {
    const diff = d.tot - meta * 60;
    md += `| ${d.nombre} | ${d.ls.length} | **${dec(d.tot)} h** | ${meta}.00 h | ${diff >= 0 ? "+" : ""}${dec(diff)} h | ${((d.tot / 60 / meta) * 100).toFixed(0)}% |\n`;
  }
  md += `| **TOTAL** | **${gn}** | **${dec(gt)} h** | ${(meta * data.length).toFixed(2)} h | ${dec(gt - meta * 60 * data.length)} h | ${((gt / 60 / (meta * data.length)) * 100).toFixed(0)}% |\n\n`;

  md += `## Desglose semanal\n\n| Persona | ${semanas.map(s => `${s.ini.slice(5)}→${s.fin.slice(5)}<br><sub>meta ${(s.habiles * HORAS_DIA).toFixed(0)}h</sub>`).join(" | ")} |\n|---|${semanas.map(() => "---:").join("|")}|\n`;
  for (const d of data) {
    md += `| ${d.nombre} | ${semanas.map(s => {
      const m = d.ls.filter(l => l.date >= s.ini && l.date <= s.fin).reduce((a, l) => a + mins(l), 0);
      return m ? dec(m) : "—";
    }).join(" | ")} |\n`;
  }

  md += `\n## Horas por tipo de registro\n\n| Persona | ${TIPOS.join(" | ")} |\n|---|${TIPOS.map(() => "---:").join("|")}|\n`;
  for (const d of data) {
    md += `| ${d.nombre} | ${TIPOS.map(t => {
      const m = d.ls.filter(l => l.type === t).reduce((a, l) => a + mins(l), 0);
      return m ? dec(m) : "—";
    }).join(" | ")} |\n`;
  }

  md += `\n## Uso de notas en los registros\n\n`;
  md += `> Un registro sin nota no dice en qué se trabajó: el tiempo cuenta, pero no se puede explicar ni auditar.\n\n`;
  md += `| Persona | Registros | Con nota | Sin nota | % con nota |\n|---|---:|---:|---:|---:|\n`;
  for (const d of data) {
    const con = d.ls.filter(conNota).length, tot = d.ls.length;
    md += `| ${d.nombre} | ${tot} | ${con} | ${tot - con} | ${tot ? Math.round(con * 100 / tot) : 0}% |\n`;
  }
  {
    const todos = data.flatMap(d => d.ls), con = todos.filter(conNota).length;
    md += `| **TOTAL** | **${todos.length}** | **${con}** | **${todos.length - con}** | **${todos.length ? Math.round(con * 100 / todos.length) : 0}%** |\n`;
  }

  md += `\n## Indicadores de valor del registro\n\n`;
  md += `> Mide qué tan utilizable es la hora registrada, no cuántas son. **Nota útil**: la nota tiene 20 caracteres o más. **A tiempo**: se capturó el mismo día o al siguiente del día trabajado. **Admin**: horas en proyectos de administración interna.\n\n`;
  md += `| Persona | Registros | h/registro | Días con registro | A tiempo | Nota útil | Proyectos | % admin |\n|---|---:|---:|---:|---:|---:|---:|---:|\n`;
  for (const d of data) {
    const n = d.ls.length || 1;
    const dias = new Set(d.ls.map(l => l.date)).size;
    const proy = new Set(d.ls.map(l => l.project?.name)).size;
    const adminM = d.ls.filter(esAdmin).reduce((a, l) => a + mins(l), 0);
    const totM = d.ls.reduce((a, l) => a + mins(l), 0) || 1;
    md += `| ${d.nombre} | ${d.ls.length} | ${dec(totM / n)} | ${dias} de ${semanas.reduce((a, s) => a + s.habiles, 0)} | ${Math.round(d.ls.filter(aTiempo).length * 100 / n)}% | ${Math.round(d.ls.filter(notaUtil).length * 100 / n)}% | ${proy} | ${Math.round(adminM * 100 / totM)}% |\n`;
  }

  md += `\n## Distribución por proyecto\n\n| Persona | Proyectos (horas) |\n|---|---|\n`;
  for (const d of data) {
    const pr = {};
    for (const l of d.ls) pr[l.project?.name || "?"] = (pr[l.project?.name || "?"] || 0) + mins(l);
    md += `| ${d.nombre} | ${Object.entries(pr).sort((a, b) => b[1] - a[1]).map(([p, m]) => `${p} ${dec(m)}h`).join(" · ") || "—"} |\n`;
  }

  const todos = data.flatMap(d => d.ls);
  const largos = todos.filter(l => mins(l) > 12 * 60).sort((a, b) => mins(b) - mins(a));
  const finde = todos.filter(l => [0, 6].includes(new Date(`${l.date}T00:00:00Z`).getUTCDay()));
  const sinNota = todos.filter(l => !String(l.notes || "").trim());
  md += `\n---\n\n# Anexo: calidad del dato\n\nA revisar antes de tomar estos números como definitivos:\n\n`;
  md += `- **${largos.length} registros de más de 12 h en un solo día** — patrón típico de timer que se quedó corriendo`;
  if (largos.length) {
    md += `:\n\n| Horas | Fecha | Persona | Proyecto | Nota |\n|---:|---|---|---|---|\n`;
    for (const l of largos) {
      md += `| ${l.log_hour} | ${l.date} | ${l.owner?.name} | ${l.project?.name} | ${(String(l.notes || "").replace(/\s+/g, " ").trim() || "_(sin nota)_").slice(0, 80)} |\n`;
    }
  } else md += `.\n`;
  md += `\n- **${sinNota.length} de ${todos.length} registros sin nota** (${todos.length ? (sinNota.length / todos.length * 100).toFixed(0) : 0}%): no se puede auditar en qué se fue ese tiempo.\n`;
  md += `- **${finde.length} registros en sábado o domingo** (${dec(finde.reduce((a, l) => a + mins(l), 0))} h): cuentan como trabajadas pero no suman días hábiles a la meta.\n`;

  md += `\n---\n\n# Detalle de notas por registro\n`;
  for (const d of data) {
    md += `\n## ${d.nombre}\n\n_${d.ls.length} registros · ${dec(d.tot)} h_\n\n`;
    if (!d.ls.length) { md += `Sin registros en el periodo.\n`; continue; }
    md += `| Fecha | Horas | Tipo | Proyecto | Tarea / Issue | Nota |\n|---|---:|---|---|---|---|\n`;
    for (const l of [...d.ls].sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)))) {
      const nota = String(l.notes || "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim() || "_(sin nota)_";
      const ent = `${l.module_detail?.prefix || ""} ${String(l.module_detail?.name || "").replace(/\|/g, "\\|")}`.trim();
      md += `| ${l.date} | ${l.log_hour} | ${l.type} | ${l.project?.name || ""} | ${ent} | ${nota} |\n`;
    }
  }
  md += `\n---\n\n## Resumen ejecutivo\n\n`;
  for (const [titulo, texto] of deducir(data, semanas, meta))
    md += `**${titulo}.** ${String(texto).replace(/<\/?b>/g, "**")}\n\n`;
  md += `_Lectura automática de los datos del mes. La meta de ${meta} h no descuenta vacaciones, incapacidades ni festivos; cada señal requiere confirmación antes de tomarse como conclusión._\n`;
  return md;
}


/** Deduce los hallazgos del mes a partir de los datos ya calculados.
 *  Devuelve frases en lenguaje llano; cada una se apoya en un número del informe,
 *  nunca en una apreciación. */
function deducir(data, semanas, meta) {
  const todos = data.flatMap(d => d.ls);
  const habiles = semanas.reduce((a, s) => a + s.habiles, 0);
  const horas = (d) => d.tot / 60;
  const pct = (d) => Math.round(horas(d) * 100 / meta);
  const pctNota = (d) => d.ls.length ? Math.round(d.ls.filter(conNota).length * 100 / d.ls.length) : 0;
  const pctUtil = (d) => d.ls.length ? Math.round(d.ls.filter(notaUtil).length * 100 / d.ls.length) : 0;
  const pctAdmin = (d) => {
    const tot = d.ls.reduce((a, l) => a + mins(l), 0) || 1;
    return Math.round(d.ls.filter(esAdmin).reduce((a, l) => a + mins(l), 0) * 100 / tot);
  };
  const pctTiempo = (d) => d.ls.length ? Math.round(d.ls.filter(aTiempo).length * 100 / d.ls.length) : 0;
  const nom = (d) => d.nombre;
  const lista = (arr, f = nom) => arr.map(f).join(", ");

  const totalH = todos.reduce((a, l) => a + mins(l), 0) / 60;
  const metaTotal = meta * data.length;
  const notaG = todos.length ? Math.round(todos.filter(conNota).length * 100 / todos.length) : 0;
  const utilG = todos.length ? Math.round(todos.filter(notaUtil).length * 100 / todos.length) : 0;
  const tiempoG = todos.length ? Math.round(todos.filter(aTiempo).length * 100 / todos.length) : 0;

  const arriba = data.filter(d => pct(d) >= 100);
  const bajos = data.filter(d => pct(d) < 60);
  const sinNotas = data.filter(d => pctNota(d) < 60);
  const notaPobre = data.filter(d => pctNota(d) >= 60 && pctUtil(d) < 60);
  const adminAlto = data.filter(d => pctAdmin(d) >= 70);
  const pocosDias = data.filter(d => new Set(d.ls.map(l => l.date)).size < habiles * 0.6);
  const bloquesGrandes = data.filter(d => d.ls.length && (d.tot / d.ls.length) / 60 >= 7);
  const largos = todos.filter(l => mins(l) > 12 * 60);
  const finde = todos.filter(l => [0, 6].includes(new Date(`${l.date}T00:00:00Z`).getUTCDay()));

  const H = [];
  H.push([`Cumplimiento`, `El equipo registró <b>${totalH.toFixed(0)} h</b> de las <b>${metaTotal.toFixed(0)} h</b> de referencia (${Math.round(totalH * 100 / metaTotal)} %). ` +
    (arriba.length ? `Por encima de la meta: <b>${lista(arriba)}</b>. ` : "") +
    (bajos.length ? `Por debajo del 60 %: <b>${lista(bajos)}</b> — antes de leerlo como falta de carga hay que descontar vacaciones, incapacidades y altas a mitad de mes.` : "")]);
  H.push([`Oportunidad del registro`, tiempoG >= 90
    ? `<b>${tiempoG} %</b> de los registros se capturaron el mismo día o al siguiente. El equipo no está cargando el mes al final, que es la principal fuente de horas inventadas.`
    : `Solo <b>${tiempoG} %</b> de los registros se capturó el mismo día o al siguiente: hay captura en bloque, y eso vuelve el dato poco confiable.`]);
  H.push([`Trazabilidad`, `<b>${notaG} %</b> de los registros trae nota y <b>${utilG} %</b> trae una nota con contenido real. ` +
    (sinNotas.length ? `Sin nota en más del 40 % de sus registros: <b>${lista(sinNotas)}</b>. Esas horas cuentan para el total pero no se pueden explicar ante el cliente ni auditar. ` : "") +
    (notaPobre.length ? `Con nota pero demasiado breve para servir: <b>${lista(notaPobre)}</b>.` : "")]);
  if (adminAlto.length) H.push([`Concentración en administración`, `<b>${lista(adminAlto.map(d => `${nom(d)} (${pctAdmin(d)} %)`), x => x)}</b> tienen la mayor parte de su tiempo en proyectos de administración interna. ` +
    `Hay dos lecturas y conviene distinguirlas: que efectivamente su trabajo sea de gestión, o que estén cargando a administración tiempo que corresponde a un proyecto. En el segundo caso, el costo por proyecto del año está subestimado.`]);
  if (bloquesGrandes.length) H.push([`Granularidad`, `<b>${lista(bloquesGrandes.map(d => `${nom(d)} (${((d.tot / d.ls.length) / 60).toFixed(1)} h por registro)`), x => x)}</b> registran la jornada en un solo bloque. Un bloque diario único impide saber en qué se fue el día y suele venir acompañado de nota ausente o genérica.`]);
  if (pocosDias.length) H.push([`Continuidad`, `<b>${lista(pocosDias.map(d => `${nom(d)} (${new Set(d.ls.map(l => l.date)).size} de ${habiles} días)`), x => x)}</b> registraron en menos del 60 % de los días hábiles. Revisar si fue alta reciente, vacaciones o registro pendiente.`]);
  if (largos.length || finde.length) H.push([`Señales a verificar`, `${largos.length} registro(s) de más de 12 h en un día` + (finde.length ? ` y ${finde.length} en sábado o domingo` : "") + `. Los primeros suelen ser un timer que se quedó corriendo; los segundos cuentan como trabajadas pero no suman días hábiles a la meta.`]);
  return H;
}

function generarHtml(data, semanas, meta, resumenAprobacion) {
  const gt = data.reduce((a, d) => a + d.tot, 0);
  const gn = data.reduce((a, d) => a + d.ls.length, 0);
  const pct = d => (d.tot / 60 / meta) * 100;
  const clase = p => p >= 95 ? "ok" : p >= 70 ? "warn" : "crit";
  const todos = data.flatMap(d => d.ls);
  const largos = todos.filter(l => mins(l) > 12 * 60).sort((a, b) => mins(b) - mins(a));
  const finde = todos.filter(l => [0, 6].includes(new Date(`${l.date}T00:00:00Z`).getUTCDay()));
  const sinNota = todos.filter(l => !String(l.notes || "").trim());
  const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Informe de horas ${esc(TEAM_NAME)} ${MONTH}</title>
<style>
  :root{
    --slate:#3C4E5D; --slate-dark:#2C3A46; --gold:#C7B383; --gold-soft:#EFE8D6;
    --ink:#22303a; --muted:#6b7a85; --line:#dfe4e8; --bg-soft:#f6f8f9;
    --ok:#2f855a; --ok-bg:#e6f4ec; --warn:#b7791f; --warn-bg:#fbf3e2;
    --crit:#c0392b; --crit-bg:#fbeae8;
  }
  *{box-sizing:border-box;}
  html,body{margin:0;padding:0;}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
       color:var(--ink);font-size:12px;line-height:1.5;
       -webkit-print-color-adjust:exact;print-color-adjust:exact;}
  .page{padding:0 34px;}
  .cover{height:100vh;display:flex;flex-direction:column;justify-content:center;align-items:center;
         text-align:center;background:linear-gradient(160deg,#fdfdfc 0%,var(--gold-soft) 100%);
         page-break-after:always;padding:40px;}
  .cover img{width:280px;max-width:70%;margin-bottom:40px;}
  .cover .kicker{letter-spacing:3px;text-transform:uppercase;color:var(--gold);font-weight:700;font-size:13px;margin-bottom:10px;}
  .cover h1{color:var(--slate);font-size:34px;margin:0 0 8px;font-weight:800;line-height:1.15;}
  .cover h2{color:var(--muted);font-size:16px;font-weight:500;margin:0 0 36px;}
  .cover .meta{background:#fff;border:1px solid var(--line);border-radius:12px;padding:20px 28px;
               display:grid;grid-template-columns:auto auto;gap:8px 32px;text-align:left;
               box-shadow:0 6px 24px rgba(60,78,93,.08);}
  .cover .meta div{font-size:12.5px;}
  .cover .meta b{color:var(--slate);}
  .cover .version{margin-top:20px;background:var(--slate);color:#fff;padding:8px 22px;border-radius:8px;
                  font-size:15px;font-weight:700;letter-spacing:1px;}
  h2.section{color:var(--slate);font-size:18px;border-bottom:3px solid var(--gold);padding-bottom:6px;margin:28px 0 14px;}
  h3.item{color:var(--slate-dark);font-size:13.5px;margin:20px 0 6px;padding-left:10px;border-left:4px solid var(--gold);}
  p{margin:6px 0;}
  table{width:100%;border-collapse:collapse;margin:10px 0 4px;font-size:10.5px;}
  th{background:var(--slate);color:#fff;text-align:left;padding:7px 9px;font-weight:600;}
  td{padding:6px 9px;border-bottom:1px solid var(--line);vertical-align:top;}
  tr:nth-child(even) td{background:var(--bg-soft);}
  td.num,th.num{text-align:right;white-space:nowrap;}
  .pill{display:inline-block;padding:2px 9px;border-radius:20px;font-weight:700;font-size:10px;}
  .pill.ok{background:var(--ok-bg);color:var(--ok);}
  .pill.warn{background:var(--warn-bg);color:var(--warn);}
  .pill.crit{background:var(--crit-bg);color:var(--crit);}
  .callout{background:var(--bg-soft);border-left:4px solid var(--gold);padding:10px 14px;margin:14px 0;font-size:11px;}
  .callout.ok{background:var(--ok-bg);border-left-color:var(--ok);}
  .nota{color:var(--muted);}
  .avoid{page-break-inside:avoid;}
  .persona{page-break-before:always;}
  tfoot td{font-weight:700;background:var(--gold-soft) !important;border-top:2px solid var(--gold);}
</style>
</head>
<body>

<div class="cover">
  <img src="${esc(relative(OUT_DIR, join(ROOT, "assets", "sigob-5.png")).split(/[\\/]/).join("/") || "sigob-5.png")}" alt="SIGOB">
  <div class="kicker">Informe de horas</div>
  <h1>${esc(TEAM_NAME)}</h1>
  <h2>${MESES[MON - 1]} ${YEAR}</h2>
  <div class="meta">
    <div><b>Periodo</b></div><div>${FROM} a ${TO}</div>
    <div><b>Portal</b></div><div>${esc(process.env.ZOHO_PORTAL_NAME || "")}</div>
    <div><b>Personas</b></div><div>${data.length}</div>
    <div><b>Registros</b></div><div>${gn}</div>
    <div><b>Horas registradas</b></div><div>${dec(gt)} h</div>
    <div><b>Jornada de referencia</b></div><div>${HORAS_SEMANA} h/semana</div>
  </div>
  <div class="version">${MONTH}</div>
</div>

<div class="page">
  <h2 class="section">Estado de aprobación</h2>
  <div class="callout ok">${esc(resumenAprobacion).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")}</div>

  <h2 class="section">Base de comparación</h2>
  <p>Jornada de referencia: <b>${HORAS_SEMANA} h/semana = ${HORAS_DIA} h por día hábil</b>.
     El periodo tiene <b>${semanas.reduce((a, s) => a + s.habiles, 0)} días hábiles</b>, por lo que la meta del mes es <b>${meta} h</b>.</p>
  <div class="callout"><b>Alcance.</b> Solo se cuentan horas registradas en Zoho en este portal, en los tres tipos de registro
     (<code>task</code>, <code>issue</code>, <code>general</code>). Vacaciones, incapacidades, festivos y trabajo no registrado
     <b>no</b> están descontados de la meta: un porcentaje bajo no equivale por sí solo a bajo desempeño.</div>

  <h2 class="section">Horas trabajadas vs. horas laborales</h2>
  <table class="avoid">
    <thead><tr><th>Persona</th><th class="num">Registros</th><th class="num">Horas</th><th class="num">Meta</th><th class="num">Diferencia</th><th class="num">Cumplimiento</th></tr></thead>
    <tbody>
    ${data.map(d => {
      const p = pct(d), diff = d.tot - meta * 60;
      return `<tr><td>${esc(d.nombre)}</td><td class="num">${d.ls.length}</td><td class="num"><b>${dec(d.tot)} h</b></td>
        <td class="num">${meta}.00 h</td><td class="num">${diff >= 0 ? "+" : ""}${dec(diff)} h</td>
        <td class="num"><span class="pill ${clase(p)}">${p.toFixed(0)}%</span></td></tr>`;
    }).join("\n    ")}
    </tbody>
    <tfoot><tr><td>TOTAL</td><td class="num">${gn}</td><td class="num">${dec(gt)} h</td>
      <td class="num">${(meta * data.length).toFixed(2)} h</td><td class="num">${dec(gt - meta * 60 * data.length)} h</td>
      <td class="num">${((gt / 60 / (meta * data.length)) * 100).toFixed(0)}%</td></tr></tfoot>
  </table>

  <h2 class="section">Desglose semanal</h2>
  <table class="avoid">
    <thead><tr><th>Persona</th>${semanas.map(s => `<th class="num">${s.ini.slice(5)}→${s.fin.slice(5)}<br><span style="font-weight:400;opacity:.8;">meta ${(s.habiles * HORAS_DIA).toFixed(0)}h</span></th>`).join("")}</tr></thead>
    <tbody>
    ${data.map(d => `<tr><td>${esc(d.nombre)}</td>${semanas.map(s => {
      const m = d.ls.filter(l => l.date >= s.ini && l.date <= s.fin).reduce((a, l) => a + mins(l), 0);
      return `<td class="num">${m ? dec(m) : '<span class="nota">—</span>'}</td>`;
    }).join("")}</tr>`).join("\n    ")}
    </tbody>
  </table>

  <h2 class="section">Horas por tipo de registro</h2>
  <table class="avoid">
    <thead><tr><th>Persona</th>${TIPOS.map(t => `<th class="num">${t}</th>`).join("")}</tr></thead>
    <tbody>
    ${data.map(d => `<tr><td>${esc(d.nombre)}</td>${TIPOS.map(t => {
      const m = d.ls.filter(l => l.type === t).reduce((a, l) => a + mins(l), 0);
      return `<td class="num">${m ? dec(m) : '<span class="nota">—</span>'}</td>`;
    }).join("")}</tr>`).join("\n    ")}
    </tbody>
  </table>

  <h2 class="section">Uso de notas en los registros</h2>
  <p class="nota">Un registro sin nota no dice en qué se trabajó: el tiempo cuenta, pero no se puede explicar ni auditar.</p>
  <table class="avoid">
    <thead><tr><th>Persona</th><th class="num">Registros</th><th class="num">Con nota</th><th class="num">Sin nota</th><th class="num">% con nota</th></tr></thead>
    <tbody>
    ${data.map(d => {
      const con = d.ls.filter(conNota).length, tot = d.ls.length;
      const pct = tot ? Math.round(con * 100 / tot) : 0;
      const cls = pct >= 90 ? "ok" : pct >= 60 ? "med" : "crit";
      return `<tr><td>${esc(d.nombre)}</td><td class="num">${tot}</td><td class="num">${con}</td><td class="num">${tot - con}</td><td class="num"><span class="pill ${cls}">${pct}%</span></td></tr>`;
    }).join("\n    ")}
    ${(() => {
      const todos = data.flatMap(d => d.ls), con = todos.filter(conNota).length;
      const pct = todos.length ? Math.round(con * 100 / todos.length) : 0;
      return `<tr><td><b>TOTAL</b></td><td class="num"><b>${todos.length}</b></td><td class="num"><b>${con}</b></td><td class="num"><b>${todos.length - con}</b></td><td class="num"><b>${pct}%</b></td></tr>`;
    })()}
    </tbody>
  </table>

  <h2 class="section">Indicadores de valor del registro</h2>
  <p class="nota">Mide qué tan utilizable es la hora registrada, no cuántas son. <b>Nota útil</b>: 20 caracteres o más. <b>A tiempo</b>: capturada el mismo día o al siguiente. <b>Admin</b>: horas en proyectos de administración interna.</p>
  <table class="avoid">
    <thead><tr><th>Persona</th><th class="num">Registros</th><th class="num">h/registro</th><th class="num">Días con registro</th><th class="num">A tiempo</th><th class="num">Nota útil</th><th class="num">Proyectos</th><th class="num">% admin</th></tr></thead>
    <tbody>
    ${data.map(d => {
      const n = d.ls.length || 1;
      const dias = new Set(d.ls.map(l => l.date)).size;
      const proy = new Set(d.ls.map(l => l.project?.name)).size;
      const adminM = d.ls.filter(esAdmin).reduce((a, l) => a + mins(l), 0);
      const totM = d.ls.reduce((a, l) => a + mins(l), 0) || 1;
      const pTiempo = Math.round(d.ls.filter(aTiempo).length * 100 / n);
      const pNota = Math.round(d.ls.filter(notaUtil).length * 100 / n);
      const pill = (v) => v >= 90 ? "ok" : v >= 60 ? "med" : "crit";
      return `<tr><td>${esc(d.nombre)}</td><td class="num">${d.ls.length}</td><td class="num">${dec(totM / n)}</td><td class="num">${dias} de ${semanas.reduce((a, s) => a + s.habiles, 0)}</td>`
        + `<td class="num"><span class="pill ${pill(pTiempo)}">${pTiempo}%</span></td>`
        + `<td class="num"><span class="pill ${pill(pNota)}">${pNota}%</span></td>`
        + `<td class="num">${proy}</td><td class="num">${Math.round(adminM * 100 / totM)}%</td></tr>`;
    }).join("\n    ")}
    </tbody>
  </table>

  <h2 class="section">Distribución por proyecto</h2>
  <table>
    <thead><tr><th>Persona</th><th>Proyectos (horas)</th></tr></thead>
    <tbody>
    ${data.map(d => {
      const pr = {};
      for (const l of d.ls) pr[l.project?.name || "?"] = (pr[l.project?.name || "?"] || 0) + mins(l);
      return `<tr><td>${esc(d.nombre)}</td><td>${Object.entries(pr).sort((a, b) => b[1] - a[1]).map(([p, m]) => `${esc(p)} <b>${dec(m)}h</b>`).join(" · ") || "—"}</td></tr>`;
    }).join("\n    ")}
    </tbody>
  </table>

  <h2 class="section">Anexo: calidad del dato</h2>
  <p>A revisar antes de tomar estos números como definitivos:</p>
  <p><b>${largos.length} registros de más de 12 h en un solo día</b> — patrón típico de timer que se quedó corriendo.</p>
  ${largos.length ? `<table class="avoid">
    <thead><tr><th class="num">Horas</th><th>Fecha</th><th>Persona</th><th>Proyecto</th><th>Nota</th></tr></thead>
    <tbody>${largos.map(l => `<tr><td class="num"><b>${l.log_hour}</b></td><td>${l.date}</td><td>${esc(l.owner?.name)}</td><td>${esc(l.project?.name)}</td><td>${esc(String(l.notes || "").replace(/\s+/g, " ").trim() || "(sin nota)")}</td></tr>`).join("")}</tbody>
  </table>` : ""}
  <p><b>${sinNota.length} de ${todos.length} registros sin nota</b> (${todos.length ? (sinNota.length / todos.length * 100).toFixed(0) : 0}%): no se puede auditar en qué se fue ese tiempo.</p>
  <p><b>${finde.length} registros en sábado o domingo</b> (${dec(finde.reduce((a, l) => a + mins(l), 0))} h): cuentan como trabajadas pero no suman días hábiles a la meta.</p>
</div>

${data.map(d => `<div class="page persona">
  <h2 class="section">${esc(d.nombre)}</h2>
  <p class="nota">${d.ls.length} registros · <b>${dec(d.tot)} h</b> de ${meta} h · ${pct(d).toFixed(0)}% · ${esc(d.email)}</p>
  ${d.ls.length ? `<table>
    <thead><tr><th>Fecha</th><th class="num">Horas</th><th>Tipo</th><th>Proyecto</th><th>Tarea / Issue</th><th>Nota</th></tr></thead>
    <tbody>${[...d.ls].sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id))).map(l =>
      `<tr><td>${l.date}</td><td class="num">${l.log_hour}</td><td>${l.type}</td><td>${esc(l.project?.name)}</td>
       <td>${esc(`${l.module_detail?.prefix || ""} ${l.module_detail?.name || ""}`.trim())}</td>
       <td>${String(l.notes || "").trim() ? esc(String(l.notes).replace(/\s+/g, " ")) : '<span class="nota">(sin nota)</span>'}</td></tr>`).join("")}
    </tbody></table>` : "<p>Sin registros en el periodo.</p>"}
</div>`).join("\n")}

  <h2 class="section">Resumen ejecutivo</h2>
  ${deducir(data, semanas, meta).map(([titulo, texto]) =>
    `<p style="margin:8px 0"><b>${esc(titulo)}.</b> ${texto}</p>`).join("\n  ")}
  <p class="nota" style="margin-top:14px">Lectura automática de los datos del mes. La meta de ${meta} h no descuenta vacaciones, incapacidades ni festivos; cada señal requiere confirmación antes de tomarse como conclusión.</p>
</body>
</html>`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const portal = await resolvePortal();
console.log(`Equipo: ${TEAM_NAME} (${TEAM.length} personas) · Periodo: ${FROM} a ${TO} · Portal ${portal}`);
if (DRY) console.log("MODO DRY-RUN: no se aprobará nada.\n");

console.log("Descargando registros…");
const mes = await descargarMes(portal);
const equipo = mes.filter(esDelEquipo);
const pendientes = equipo.filter(l => (l.approval?.status || "").toLowerCase() === "pending");
console.log(`  ${mes.length} registros en el periodo · ${equipo.length} del equipo · ${pendientes.length} pendientes`);

let resumen;
if (!pendientes.length) {
  resumen = `**Aprobación:** no había registros pendientes. El equipo tiene **${equipo.length} registros** en el periodo, todos aprobados.`;
  console.log("No hay nada pendiente por aprobar.");
} else if (DRY) {
  const h = dec(pendientes.reduce((a, l) => a + mins(l), 0));
  resumen = `**Aprobación:** hay **${pendientes.length} registros pendientes** (${h} h) sin aprobar. Este informe se generó en modo \`--dry-run\`.`;
  console.log(`\nPendientes (${h} h):`);
  for (const l of pendientes) console.log(`  ${l.date} ${l.log_hour} ${l.owner?.name} | ${l.project?.name} | ${l.type} | ${l.id}`);
} else {
  console.log(`Aprobando ${pendientes.length} registros en lotes…`);
  const { ok, errores } = await aprobarLote(portal, pendientes);
  console.log(`  aprobados=${ok} errores=${errores.length}`);
  errores.forEach(e => console.error("  ERROR", e));
  for (const l of pendientes) if (l.approval) l.approval.status = "Approved";
  resumen = `**Aprobación:** se aprobaron **${ok} de ${pendientes.length} registros** que estaban en \`Pending\`. ` +
            `El equipo cierra el periodo con **${equipo.length} registros**${errores.length ? `, con ${errores.length} error(es) de aprobación` : ", todos aprobados"}.`;
}

if (args["no-report"]) process.exit(0);

const semanas = semanasDelMes();
const meta = semanas.reduce((a, s) => a + s.habiles, 0) * HORAS_DIA;
const data = construirDatos(equipo);
const slug = TEAM_NAME.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toUpperCase();
mkdirSync(OUT_DIR, { recursive: true });
const base = join(OUT_DIR, `${MONTH}-${slug}`);

writeFileSync(`${base}.md`, generarMarkdown(data, semanas, meta, resumen));
writeFileSync(`${base}.html`, generarHtml(data, semanas, meta, resumen));
console.log(`\n${base}.md`);
console.log(`${base}.html`);

try {
  execFileSync("node", [join(ROOT, "scripts", "html-to-pdf.mjs"), `${base}.html`, `${base}.pdf`], { stdio: "inherit" });
} catch {
  console.error("No se pudo generar el PDF (¿puppeteer instalado?). El HTML sí quedó listo.");
}
