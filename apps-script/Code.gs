/**
 * Backend de "¿A dónde irá?" — Google Apps Script sobre una Google Sheet.
 *
 * Instalación (una sola vez):
 *  1. En la Google Sheet: Extensiones > Apps Script. Pega este archivo como Code.gs.
 *  2. Ejecuta la función `configurar` (botón ▶). Crea las pestañas y la clave del kiosko.
 *  3. Implementar > Nueva implementación > Aplicación web
 *       Ejecutar como: Yo   ·   Quién tiene acceso: Cualquier persona
 *  4. Copia la URL que termina en /exec y pégala en js/config.js de la página.
 *
 * Control durante el evento: cambia el valor de `estado` en la pestaña Config.
 *   abierta      → cualquiera puede votar
 *   solo_kiosko  → solo vota el navegador del kiosko
 *   cerrada      → nadie vota; todos ven el mapa
 *   revelado     → se muestra el ranking (llena también `mision_real_id`)
 * Los cambios se ven en la página en máximo ~15 segundos.
 */

const HOJA_PRED = 'Predicciones';
const HOJA_CONFIG = 'Config';
const CACHE_KEY = 'lista_v1';
const CACHE_SEG = 15;
const ESTADOS = ['abierta', 'solo_kiosko', 'cerrada', 'revelado'];
const MAX_POR_PERSONA = 2;

function configurar() {
  const ss = SpreadsheetApp.getActive();
  let pred = ss.getSheetByName(HOJA_PRED);
  if (!pred) pred = ss.insertSheet(HOJA_PRED);
  if (pred.getLastRow() === 0) {
    pred.appendRow(['fecha', 'nombre', 'mision_id', 'mision', 'origen', 'dispositivo']);
    pred.setFrozenRows(1);
  }
  let cfg = ss.getSheetByName(HOJA_CONFIG);
  if (!cfg) cfg = ss.insertSheet(HOJA_CONFIG);
  if (cfg.getLastRow() === 0) {
    const clave = Utilities.getUuid().slice(0, 8);
    cfg.getRange(1, 1, 4, 3).setValues([
      ['clave', 'valor', 'nota'],
      ['estado', 'abierta', 'abierta | solo_kiosko | cerrada | revelado'],
      ['clave_kiosko', clave, 'Abre la página con ?kiosko=' + clave + ' en la computadora del kiosko'],
      ['mision_real_id', '', 'ID de la misión real (de misiones.csv). Llénalo y pon estado = revelado'],
    ]);
    cfg.setFrozenRows(1);
  }
  CacheService.getScriptCache().remove(CACHE_KEY);
}

function leerConfig_() {
  const cfg = SpreadsheetApp.getActive().getSheetByName(HOJA_CONFIG);
  const out = {};
  cfg.getDataRange().getValues().slice(1).forEach(function (r) {
    out[String(r[0]).trim()] = String(r[1]).trim();
  });
  if (ESTADOS.indexOf(out.estado) < 0) out.estado = 'cerrada';
  return out;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** GET → lista de predicciones + estado (en caché unos segundos). */
function doGet(e) {
  const cache = CacheService.getScriptCache();
  const enCache = cache.get(CACHE_KEY);
  if (enCache) return ContentService.createTextOutput(enCache).setMimeType(ContentService.MimeType.JSON);

  const cfg = leerConfig_();
  const hoja = SpreadsheetApp.getActive().getSheetByName(HOJA_PRED);
  const filas = hoja.getLastRow() > 1
    ? hoja.getRange(2, 1, hoja.getLastRow() - 1, 3).getValues()
    : [];
  const predicciones = filas
    .filter(function (r) { return r[1] && r[2]; })
    .map(function (r) {
      return { f: new Date(r[0]).getTime(), n: String(r[1]), m: Number(r[2]) };
    });
  const texto = JSON.stringify({
    ok: true,
    estado: cfg.estado,
    mision_real_id: cfg.estado === 'revelado' ? Number(cfg.mision_real_id) || null : null,
    predicciones: predicciones,
  });
  try { cache.put(CACHE_KEY, texto, CACHE_SEG); } catch (err) { /* >100KB: sin caché */ }
  return ContentService.createTextOutput(texto).setMimeType(ContentService.MimeType.JSON);
}

/** POST → guarda 1 a 3 predicciones de una persona. */
function doPost(e) {
  let datos;
  try {
    datos = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Datos inválidos.' });
  }

  if (datos.accion === 'admin') return admin_(datos);

  const cfg = leerConfig_();
  const esKiosko = !!datos.kiosko && datos.kiosko === cfg.clave_kiosko;
  if (cfg.estado === 'cerrada' || cfg.estado === 'revelado') {
    return json_({ ok: false, error: 'La votación ya está cerrada.', estado: cfg.estado });
  }
  if (cfg.estado === 'solo_kiosko' && !esKiosko) {
    return json_({ ok: false, error: 'La votación en línea ya cerró. Ahora solo se vota en la reunión.', estado: cfg.estado });
  }

  const nombre = limpiar_(datos.nombre).slice(0, 60);
  if (nombre.length < 3) return json_({ ok: false, error: 'Escribe tu nombre y apellido.' });

  const misiones = (Array.isArray(datos.misiones) ? datos.misiones : [])
    .slice(0, MAX_POR_PERSONA)
    .map(function (x) { return { id: parseInt(x.id, 10), n: limpiar_(x.n).slice(0, 80) }; })
    .filter(function (x) { return x.id > 0 && x.id < 10000; });
  if (!misiones.length) return json_({ ok: false, error: 'Elige al menos una misión.' });

  const ahora = new Date();
  const origen = esKiosko ? 'kiosko' : 'en línea';
  const disp = limpiar_(datos.dispositivo).slice(0, 40);

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000); // las escrituras simultáneas esperan su turno
  } catch (err) {
    return json_({ ok: false, error: 'Hay mucha gente votando. Intenta de nuevo en unos segundos.' });
  }
  let filas;
  try {
    const hoja = SpreadsheetApp.getActive().getSheetByName(HOJA_PRED);
    // Límite de predicciones por persona (se compara el nombre sin tildes ni mayúsculas)
    const clave = normalizar_(nombre);
    const previas = [];
    if (hoja.getLastRow() > 1) {
      hoja.getRange(2, 2, hoja.getLastRow() - 1, 2).getValues().forEach(function (r) {
        const id = Number(r[1]);
        if (normalizar_(r[0]) === clave && previas.indexOf(id) < 0) previas.push(id);
      });
    }
    if (previas.length >= MAX_POR_PERSONA) {
      return json_({ ok: false, error: 'Ya hiciste tus ' + MAX_POR_PERSONA + ' predicciones.' });
    }
    const nuevas = misiones.filter(function (x, i) {
      return previas.indexOf(x.id) < 0 && misiones.findIndex(function (y) { return y.id === x.id; }) === i;
    });
    if (!nuevas.length) return json_({ ok: false, error: 'Ya habías elegido esa misión.' });
    if (previas.length + nuevas.length > MAX_POR_PERSONA) {
      return json_({ ok: false, error: 'Solo te queda ' + (MAX_POR_PERSONA - previas.length) + ' predicción.' });
    }
    filas = nuevas.map(function (x) { return [ahora, nombre, x.id, x.n, origen, disp]; });
    hoja.getRange(hoja.getLastRow() + 1, 1, filas.length, filas[0].length).setValues(filas);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  CacheService.getScriptCache().remove(CACHE_KEY);
  return json_({ ok: true, guardadas: filas.length });
}

/** Panel de control del kiosko: cambia el estado y/o la misión real. Requiere la clave del kiosko. */
function admin_(d) {
  const cfg = leerConfig_();
  if (!d.kiosko || d.kiosko !== cfg.clave_kiosko) {
    return json_({ ok: false, error: 'Esta computadora no tiene permiso para controlar la votación.' });
  }
  const cambios = {};
  if (d.estado !== undefined) {
    if (ESTADOS.indexOf(d.estado) < 0) return json_({ ok: false, error: 'Estado no válido.' });
    cambios.estado = d.estado;
  }
  if (d.mision_real_id !== undefined) {
    const id = parseInt(d.mision_real_id, 10);
    cambios.mision_real_id = id > 0 ? id : '';
  }
  const realFinal = cambios.mision_real_id !== undefined ? cambios.mision_real_id : Number(cfg.mision_real_id) || '';
  if (cambios.estado === 'revelado' && !realFinal) {
    return json_({ ok: false, error: 'Primero elige la misión real.' });
  }

  const lock = LockService.getScriptLock();
  try { lock.waitLock(25000); } catch (err) {
    return json_({ ok: false, error: 'El servidor está ocupado. Intenta de nuevo en unos segundos.' });
  }
  try {
    escribirConfig_(cambios);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  CacheService.getScriptCache().remove(CACHE_KEY);
  const nuevo = leerConfig_();
  return json_({
    ok: true,
    estado: nuevo.estado,
    mision_real_id: nuevo.estado === 'revelado' ? Number(nuevo.mision_real_id) || null : null,
  });
}

function escribirConfig_(cambios) {
  const hoja = SpreadsheetApp.getActive().getSheetByName(HOJA_CONFIG);
  const valores = hoja.getDataRange().getValues();
  Object.keys(cambios).forEach(function (clave) {
    let fila = -1;
    for (let i = 1; i < valores.length; i++) {
      if (String(valores[i][0]).trim() === clave) { fila = i + 1; break; }
    }
    if (fila === -1) hoja.appendRow([clave, cambios[clave]]);
    else hoja.getRange(fila, 2).setValue(cambios[clave]);
  });
}

/** Nombre comparable: sin tildes, sin mayúsculas, sin espacios extra. */
function normalizar_(v) {
  return String(v == null ? '' : v).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Quita espacios extra y evita que un texto se interprete como fórmula. */
function limpiar_(v) {
  let s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}
