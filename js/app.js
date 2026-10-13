(function () {
  "use strict";
  window.__appIniciada = true;

  const CFG = window.APP_CONFIG || {};
  const MAX_POR_PERSONA = 2; // predicciones que puede hacer cada persona
  const CUENTAN = 1;          // solo la primera cuenta para el premio
  const ESPERA_SEG = 60;      // espera entre envíos de una misma persona y entre "Actualizar" (no aplica al kiosko)
  const esCelular = () => window.matchMedia("(max-width: 899px)").matches;

  // ---------- Utilidades ----------
  const $ = (id) => document.getElementById(id);
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* nada */ } },
  };
  function km(a, b) {
    const R = 6371, r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  // fetch con límite de tiempo: nunca dejar la página "cargando" para siempre
  async function fetchT(url, opts, seg) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), (seg || 15) * 1000);
    try { return await fetch(url, { ...(opts || {}), signal: ctrl.signal }); }
    finally { clearTimeout(t); }
  }
  function fallaCarga(msg) {
    const c = $("cargando");
    if (c && !c.hidden) c.textContent = msg;
  }
  window.addEventListener("error", (e) => fallaCarga("Error al iniciar la página: " + (e.message || "desconocido") + ". Recarga o avisa al organizador."));

  let toastTimer;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("visible"), 3200);
  }

  // ---------- Estado ----------
  let MISIONES = [];
  let POR_ID = new Map();
  let datos = { estado: "abierta", mision_real_id: null, fecha: "", idioma: "", predicciones: [] };
  let nombre = "";
  let elegidas = []; // [{id} | null] por cada campo de opción
  let mapa, capaPredicciones, capaBase, capaLineas;
  let refrescoTimer;

  // Modo kiosko: se activa abriendo la página con ?kiosko=CLAVE (queda guardado en ese navegador)
  const params = new URLSearchParams(location.search);
  if (params.has("kiosko")) {
    const v = (params.get("kiosko") || "").trim();
    if (v) store.set("kiosko", v); else store.del("kiosko");
    params.delete("kiosko");
    const q = params.toString();
    history.replaceState(null, "", location.pathname + (q ? "?" + q : "") + location.hash);
  }
  const KIOSKO = store.get("kiosko") || "";

  // ---------- API (Apps Script o demo local) ----------
  const DEMO = !CFG.API_URL;
  const api = {
    async listar() {
      if (DEMO) return demo.listar();
      const r = await fetchT(CFG.API_URL + "?t=" + Date.now(), { redirect: "follow" }, 20);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    },
    async guardar(payload) {
      if (DEMO) return demo.guardar(payload);
      // text/plain evita la petición previa (CORS) que Apps Script no admite
      const r = await fetchT(CFG.API_URL, { method: "POST", body: JSON.stringify(payload), redirect: "follow" }, 40);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    },
  };
  api.admin = async (payload) => {
    payload = { ...payload, accion: "admin", kiosko: KIOSKO };
    if (DEMO) return demo.admin(payload);
    const r = await fetchT(CFG.API_URL, { method: "POST", body: JSON.stringify(payload), redirect: "follow" }, 40);
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  };
  const demo = {
    leer() { try { return JSON.parse(store.get("demo_pred") || "[]"); } catch (e) { return []; } },
    estado() { return store.get("demo_estado") || params.get("estado") || "abierta"; },
    listar() {
      const estado = demo.estado();
      return Promise.resolve({
        ok: true, estado,
        mision_real_id: estado === "revelado" ? Number(store.get("demo_real") || params.get("real")) || 366 : null,
        fecha: estado === "revelado" ? store.get("demo_fecha") || "" : "",
        idioma: estado === "revelado" ? store.get("demo_idioma") || "" : "",
        predicciones: demo.leer(),
      });
    },
    admin(p) {
      if (!p.kiosko) return Promise.resolve({ ok: false, error: "Esta computadora no tiene permiso para controlar la votación." });
      if (p.mision_real_id !== undefined) store.set("demo_real", String(p.mision_real_id));
      if (p.estado === "revelado" && !store.get("demo_real")) return Promise.resolve({ ok: false, error: "Primero elige la misión real." });
      if (p.estado) store.set("demo_estado", p.estado);
      if (p.fecha !== undefined) store.set("demo_fecha", p.fecha);
      if (p.idioma !== undefined) store.set("demo_idioma", p.idioma);
      return demo.listar().then((r) => ({ ...r, fecha: store.get("demo_fecha") || "", idioma: store.get("demo_idioma") || "" }));
    },
    guardar(p) {
      const estado = demo.estado();
      if (estado === "cerrada" || estado === "revelado") return Promise.resolve({ ok: false, error: "La votación ya está cerrada." });
      if (estado === "solo_kiosko" && !p.kiosko) return Promise.resolve({ ok: false, error: "La votación en línea ya cerró. Ahora solo se vota en la reunión." });
      const lista = demo.leer();
      const previas = [...new Set(lista.filter((x) => norm(x.n) === norm(p.nombre)).map((x) => x.m))];
      const nuevas = p.misiones.filter((m) => !previas.includes(m.id));
      if (previas.length >= MAX_POR_PERSONA) return Promise.resolve({ ok: false, error: `Ya hiciste tus ${MAX_POR_PERSONA} predicciones.` });
      if (previas.length + nuevas.length > MAX_POR_PERSONA) return Promise.resolve({ ok: false, error: `Solo te queda ${MAX_POR_PERSONA - previas.length} predicción.` });
      p.misiones = nuevas;
      const f = Date.now();
      p.misiones.forEach((m) => lista.push(p.apodo ? { f, n: p.nombre, m: m.id, a: p.apodo } : { f, n: p.nombre, m: m.id }));
      store.set("demo_pred", JSON.stringify(lista));
      return Promise.resolve({ ok: true, guardadas: p.misiones.length });
    },
  };

  function puedeVotar() {
    if (datos.estado === "abierta") return true;
    if (datos.estado === "solo_kiosko") return !!KIOSKO;
    return false;
  }

  // ---------- Navegación entre pantallas ----------
  function mostrar(id) {
    ["paso-nombre", "paso-mision", "vista-mapa", "cargando"].forEach((x) => { $(x).hidden = x !== id; });
    document.body.classList.toggle("en-mapa", id === "vista-mapa");
    if (id !== "vista-mapa") abrirHoja(false);
    window.scrollTo(0, 0);
    if (id === "vista-mapa") {
      iniciarMapa();
      setTimeout(() => { mapa.invalidateSize(); mapa.fire("resize"); centrarEnReal(); revisarRevelado(); }, 50);
      programarRefresco();
    } else {
      clearInterval(refrescoTimer);
    }
  }

  // Enviar la predicción de otra persona desde este mismo celular (sin perder el nombre propio)
  let modoOtra = false;
  let nombrePropio = "";
  let apodo = "";         // apodo opcional que se muestra en lugar del nombre
  let apodoPropio = "";
  function empezarOtraPersona() {
    if (!puedeVotar()) return;
    if (!modoOtra) { nombrePropio = nombre; apodoPropio = apodo; modoOtra = true; }
    nombre = ""; apodo = "";
    pedirNombre();
  }
  function terminarOtraPersona() {
    if (!modoOtra) return;
    nombre = nombrePropio;
    apodo = apodoPropio;
    modoOtra = false;
  }

  function irAPrimerPaso() {
    if (!puedeVotar()) return mostrar("vista-mapa");
    if (!nombre) { pedirNombre(); return; }
    abrirFormularioMision();
  }

  // Muestra el paso del nombre. En el kiosko siempre empieza vacío;
  // en un celular se rellena con lo último guardado para corregirlo fácil.
  function pedirNombre() {
    const vacio = KIOSKO || modoOtra;
    $("nombre").value = vacio ? "" : (store.get("nombre_n") || "");
    $("apellido").value = vacio ? "" : (store.get("nombre_a") || "");
    const apodoGuardado = vacio ? "" : (store.get("apodo") || "");
    $("apodo").value = apodoGuardado;
    mostrarCampoApodo(!!apodoGuardado);
    $("titulo-nombre").textContent = modoOtra ? "¿De quién es esta predicción?" : "¿Quién eres?";
    $("ayuda-nombre").textContent = modoOtra
      ? "Escribe el nombre y apellido de la persona a la que estás ayudando."
      : "Así sabremos de quién es cada predicción.";
    $("btn-volver-nombre").hidden = !(modoOtra || KIOSKO || prediccionesDe(nombrePropio || store.get("nombre") || "").length);
    $("error-nombre").textContent = "";
    mostrar("paso-nombre");
    $("nombre").focus();
  }

  // ---------- Paso 1: nombre ----------
  $("form-nombre").addEventListener("submit", (e) => {
    e.preventDefault();
    const limpio = (id) => $(id).value.replace(/\s+/g, " ").trim();
    const n = limpio("nombre"), a = limpio("apellido");
    if (n.length < 2) { $("error-nombre").textContent = "Escribe tu nombre."; $("nombre").focus(); return; }
    if (a.length < 2) { $("error-nombre").textContent = "Escribe tu apellido."; $("apellido").focus(); return; }
    $("error-nombre").textContent = "";
    nombre = n + " " + a;
    apodo = $("campo-apodo").hidden ? "" : limpio("apodo").slice(0, 25);
    if (!KIOSKO && !modoOtra) {
      store.set("nombre", nombre); store.set("nombre_n", n); store.set("nombre_a", a);
      if (apodo) store.set("apodo", apodo); else store.del("apodo");
    }
    if (restantesDe(nombre) <= 0) {
      if (KIOSKO || modoOtra) {
        $("error-nombre").textContent = `${nombre} ya hizo sus ${MAX_POR_PERSONA} predicciones.`;
        nombre = "";
        return;
      }
      toast(`Ya hiciste tus ${MAX_POR_PERSONA} predicciones.`);
      mostrar("vista-mapa");
      return;
    }
    abrirFormularioMision();
  });

  function mostrarCampoApodo(mostrar) {
    $("campo-apodo").hidden = !mostrar;
    $("btn-apodo").hidden = mostrar;
    $("btn-apodo").setAttribute("aria-expanded", String(mostrar));
  }
  $("btn-apodo").addEventListener("click", () => { mostrarCampoApodo(true); $("apodo").focus(); });
  $("btn-quitar-apodo").addEventListener("click", () => { $("apodo").value = ""; mostrarCampoApodo(false); $("btn-apodo").focus(); });

  $("btn-cambiar-nombre").addEventListener("click", () => {
    nombre = "";
    if (!modoOtra) store.del("nombre");
    pedirNombre();
  });
  $("btn-volver-nombre").addEventListener("click", () => {
    terminarOtraPersona();
    if (!nombre && !KIOSKO) nombre = store.get("nombre") || "";
    mostrar("vista-mapa");
  });

  // ---------- Paso 2: misiones ----------
  // Misiones (sin repetir) que ya eligió una persona, en orden de envío
  function prediccionesDe(n) {
    const k = norm(n);
    const ids = [];
    [...datos.predicciones].sort((a, b) => a.f - b.f).forEach((p) => {
      if (norm(p.n) === k && !ids.includes(p.m)) ids.push(p.m);
    });
    return ids;
  }
  const restantesDe = (n) => Math.max(0, MAX_POR_PERSONA - prediccionesDe(n).length);
  let maxOpciones = MAX_POR_PERSONA;

  function abrirFormularioMision(preseleccion) {
    const ya = prediccionesDe(nombre);
    maxOpciones = MAX_POR_PERSONA - ya.length;
    if (maxOpciones <= 0) {
      toast(`Ya hiciste tus ${MAX_POR_PERSONA} predicciones.`);
      return mostrar("vista-mapa");
    }
    if (preseleccion && ya.includes(preseleccion)) preseleccion = null;
    elegidas = [preseleccion ? { id: preseleccion } : null];
    $("ayuda-mision").textContent = ya.length
      ? `Ya elegiste ${POR_ID.get(ya[0]) ? POR_ID.get(ya[0]).n : "una misión"}, que es la que cuenta para el premio. Puedes agregar 1 opción más.`
      : `Escribe una ciudad o país y elige de la lista. Puedes poner hasta ${MAX_POR_PERSONA} misiones; para el premio solo cuenta la primera.`;
    $("quien-texto").textContent = modoOtra ? "Votando por " : "Votando como ";
    $("quien-nombre").textContent = apodo ? `${apodo} (${nombre})` : nombre;
    $("error-mision").textContent = "";
    pintarOpciones();
    mostrar("paso-mision");
    if (!preseleccion) {
      const inp = document.querySelector("#opciones input");
      if (inp) inp.focus();
    }
  }

  function pintarOpciones() {
    const ol = $("opciones");
    ol.innerHTML = "";
    elegidas.forEach((sel, i) => {
      const li = document.createElement("li");
      li.className = "opcion";
      const etiqueta = maxOpciones < MAX_POR_PERSONA || i > 0 ? "Segunda opción (no cuenta para el premio)" : "Tu predicción";
      const quitar = i > 0 ? `<button type="button" class="btn-mini" data-quitar="${i}">Quitar</button>` : "";
      if (sel) {
        const m = POR_ID.get(sel.id);
        li.innerHTML = `<div class="opcion-cabecera"><label>${etiqueta}</label>${quitar}</div>
          <div class="elegida"><div><strong>${esc(m.n)}</strong><small>${esc(m.p)}</small></div>
          <button type="button" class="btn-mini" data-cambiar="${i}">Cambiar</button></div>`;
      } else {
        const idInput = "op-" + i;
        li.innerHTML = `<div class="opcion-cabecera"><label for="${idInput}">${etiqueta}</label>${quitar}</div>
          <div class="buscador">
            <input type="text" id="${idInput}" autocomplete="off" placeholder="Ej. Lima, Perú"
              role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="sug-${i}">
            <ul class="sugerencias" id="sug-${i}" role="listbox" hidden></ul>
          </div>`;
        conectarBuscador(li.querySelector("input"), li.querySelector(".sugerencias"), i, (m) => elegirOpcion(i, m));
      }
      ol.appendChild(li);
    });
    $("btn-agregar-opcion").hidden = elegidas.length >= maxOpciones;
  }

  $("opciones").addEventListener("click", (e) => {
    const q = e.target.closest("[data-quitar]");
    const c = e.target.closest("[data-cambiar]");
    if (q) { elegidas.splice(Number(q.dataset.quitar), 1); pintarOpciones(); }
    if (c) {
      const i = Number(c.dataset.cambiar);
      elegidas[i] = null; pintarOpciones();
      const inp = $("op-" + i); if (inp) inp.focus();
    }
  });

  $("btn-agregar-opcion").addEventListener("click", () => {
    if (elegidas.length >= maxOpciones) return;
    elegidas.push(null);
    pintarOpciones();
    const inp = $("op-" + (elegidas.length - 1));
    if (inp) inp.focus();
  });

  function buscar(texto) {
    const q = norm(texto);
    if (!q) return [];
    const palabras = q.split(" ");
    const res = [];
    for (const m of MISIONES) {
      if (palabras.every((p) => m._k.includes(p))) {
        res.push({ m, score: m._kn.startsWith(q) ? 0 : (" " + m._kn).includes(" " + palabras[0]) ? 1 : 2 });
      }
    }
    res.sort((a, b) => a.score - b.score || a.m.n.localeCompare(b.m.n, "es"));
    return res.slice(0, 8).map((r) => r.m);
  }

  function elegirOpcion(i, m) {
    if (prediccionesDe(nombre).includes(m.id)) {
      $("error-mision").textContent = "Ya habías elegido esa misión antes.";
      return;
    }
    if (elegidas.some((x, j) => j !== i && x && x.id === m.id)) {
      $("error-mision").textContent = "Ya elegiste esa misión en otra opción.";
      return;
    }
    $("error-mision").textContent = "";
    elegidas[i] = { id: m.id };
    pintarOpciones();
  }

  // Buscador con lista desplegable. `i` solo sirve para ids únicos; `alElegir(m)` recibe la misión.
  function conectarBuscador(input, lista, i, alElegir) {
    let resultados = [];
    let activo = -1;
    const cerrar = () => { lista.hidden = true; input.setAttribute("aria-expanded", "false"); activo = -1; };
    const elegir = (m) => { cerrar(); alElegir(m); };
    const pintar = () => {
      if (!input.value.trim()) { cerrar(); return; }
      lista.innerHTML = resultados.length
        ? resultados.map((m, j) => `<li role="option" id="sug-${i}-${j}" data-id="${m.id}" aria-selected="${j === activo}">${esc(m.n)}<small>${esc(m.p)}</small></li>`).join("")
        : `<li class="vacio">No encontramos esa misión. Prueba con la ciudad o el país.</li>`;
      lista.hidden = false;
      input.setAttribute("aria-expanded", "true");
      input.setAttribute("aria-activedescendant", activo >= 0 ? `sug-${i}-${activo}` : "");
    };
    input.addEventListener("input", () => { resultados = buscar(input.value); activo = resultados.length ? 0 : -1; pintar(); });
    input.addEventListener("keydown", (e) => {
      if (lista.hidden) return;
      if (e.key === "ArrowDown") { e.preventDefault(); activo = Math.min(activo + 1, resultados.length - 1); pintar(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); activo = Math.max(activo - 1, 0); pintar(); }
      else if (e.key === "Enter") { if (activo >= 0) { e.preventDefault(); elegir(resultados[activo]); } }
      else if (e.key === "Escape") { cerrar(); }
    });
    // mousedown para elegir antes de que el input pierda el foco
    lista.addEventListener("mousedown", (e) => {
      const li = e.target.closest("li[data-id]");
      if (!li) return;
      e.preventDefault();
      elegir(POR_ID.get(Number(li.dataset.id)));
    });
    input.addEventListener("blur", () => setTimeout(cerrar, 150));
  }

  $("form-mision").addEventListener("submit", async (e) => {
    e.preventDefault();
    const ids = elegidas.filter(Boolean).map((x) => x.id);
    if (!ids.length) { $("error-mision").textContent = "Elige una misión de la lista."; return; }
    const claveEspera = "envio_" + norm(nombre);
    const faltan = Math.ceil((Number(store.get(claveEspera) || 0) + ESPERA_SEG * 1000 - Date.now()) / 1000);
    if (!KIOSKO && faltan > 0) {
      $("error-mision").textContent = `Espera ${faltan} segundos antes de enviar otra predicción para ${nombre}.`;
      return;
    }
    const btn = $("btn-guardar");
    btn.disabled = true; btn.textContent = "Guardando…";
    try {
      const r = await api.guardar({
        nombre,
        misiones: ids.map((id) => ({ id, n: POR_ID.get(id).n })),
        kiosko: KIOSKO,
        apodo,
        dispositivo: dispositivoId(),
      });
      if (!r.ok) {
        $("error-mision").textContent = r.error || "No se pudo guardar. Intenta de nuevo.";
        if (r.estado) { datos.estado = r.estado; }
        return;
      }
      store.set(claveEspera, String(Date.now()));
      toast(modoOtra ? `¡Predicción de ${nombre} guardada!` : ids.length === 1 ? "¡Predicción guardada!" : `¡${ids.length} predicciones guardadas!`);
      terminarOtraPersona();
      await cargarPredicciones();
      mostrar("vista-mapa");
      enfocarMision(ids[0]);
    } catch (err) {
      $("error-mision").textContent = "No hay conexión con el servidor. Revisa tu internet e intenta de nuevo.";
    } finally {
      btn.disabled = false; btn.textContent = "Guardar mi predicción";
    }
  });

  $("btn-ver-mapa").addEventListener("click", () => { terminarOtraPersona(); mostrar("vista-mapa"); });

  function dispositivoId() {
    let d = store.get("dispositivo");
    if (!d) { d = Math.random().toString(36).slice(2, 10); store.set("dispositivo", d); }
    return d;
  }

  // ---------- Mapa ----------
  // El mapa repite el mundo hacia los lados; todo se dibuja también en las copias vecinas
  const COPIAS = [-360, 0, 360];
  let lienzo = null;
  const esTactil = () => window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  const lngCercana = (lng) => (mapa ? lng + 360 * Math.round((mapa.getCenter().lng - lng) / 360) : lng);
  function iniciarMapa() {
    if (mapa) return;
    // maxBounds en latitud: el mapa no se puede arrastrar más allá de los polos (evita las zonas en blanco)
    mapa = L.map("mapa", {
      worldCopyJump: true, zoomControl: true, minZoom: 1,
      maxBounds: L.latLngBounds([-85, -100000], [85, 100000]), maxBoundsViscosity: 1,
    }).setView([10, -40], 2);
    // Zoom mínimo según el alto de la pantalla, para que el mundo siempre llene el mapa de arriba a abajo
    const ajustarZoomMin = () => {
      const alto = mapa.getSize().y;
      if (!alto) return;
      mapa.setMinZoom(Math.max(1, Math.ceil(Math.log2(alto / 256))));
    };
    ajustarZoomMin();
    mapa.on("resize", ajustarZoomMin);
    window.__mapa = mapa; // útil para depurar desde la consola
    // Fondo de mapa: OpenStreetMap (gratis, sin clave). Se puede cambiar en config.js.
    L.tileLayer(CFG.MAPA_URL || "https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: CFG.MAPA_CREDITO || '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(mapa);

    // Los puntos solo se dibujan; los toques se resuelven buscando las misiones cercanas al dedo,
    // así no hace falta acercar el mapa para atinarle a un punto pequeño.
    const tactil = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
    const RADIO_TOQUE = tactil ? 26 : 12; // px alrededor del toque/clic
    lienzo = L.canvas({ padding: 0.5 });
    capaBase = L.layerGroup();
    for (const m of MISIONES) {
      for (const off of COPIAS) {
        L.circleMarker([m.lat, m.lng + off], {
          renderer: lienzo, interactive: false, radius: tactil ? 4.5 : 3.5, weight: 1,
          color: "#005B94", fillColor: "#FFFFFF", fillOpacity: 1,
        }).addTo(capaBase);
      }
    }
    if (verMisiones) capaBase.addTo(mapa);
    agregarFiltro();
    capaLineas = L.layerGroup().addTo(mapa);
    capaPredicciones = L.layerGroup().addTo(mapa);

    // Tocar o mover el mapa cierra la lista de predicciones en celular
    mapa.on("dragstart", () => abrirHoja(false));
    mapa.on("click", (e) => {
      abrirHoja(false);
      const cerca = lugaresCerca(e.containerPoint, RADIO_TOQUE);
      if (!cerca.length) return;
      // Uno solo, o uno claramente más cerca que los demás: se abre directo
      if (cerca.length === 1 || (cerca[0].d < 6 && cerca[1].d > 14)) return abrirLugar(cerca[0]);
      abrirListaCerca(e.latlng, cerca);
    });

    // En computadora: al pasar el mouse sobre un punto se ve el nombre
    if (!tactil) {
      const tip = L.tooltip({ direction: "top", offset: [0, -6] });
      let pendiente = false;
      mapa.on("mousemove", (e) => {
        if (pendiente) return;
        pendiente = true;
        requestAnimationFrame(() => {
          pendiente = false;
          const c = lugaresCerca(e.containerPoint, 8)[0];
          mapa.getContainer().style.cursor = c ? "pointer" : "";
          if (c) tip.setLatLng([c.m.lat, c.lng]).setContent(esc(c.m.n)).addTo(mapa);
          else tip.remove();
        });
      });
      mapa.on("mouseout zoomstart", () => tip.remove());
    }
    pintarMapa();
  }

  function misionesCerca(punto, radio) {
    const res = [];
    for (const m of MISIONES) {
      for (const off of COPIAS) {
        const p = mapa.latLngToContainerPoint([m.lat, m.lng + off]);
        const d = Math.hypot(p.x - punto.x, p.y - punto.y);
        if (d <= radio) { res.push({ m, d, lng: m.lng + off }); break; }
      }
    }
    return res.sort((a, b) => a.d - b.d);
  }

  // Misiones y templos visibles cerca de un punto de la pantalla
  function lugaresCerca(punto, radio) {
    const res = [];
    if (verMisiones) misionesCerca(punto, radio).forEach((c) => res.push({ ...c, tipo: "mision" }));
    if (verTemplos && TEMPLOS) {
      TEMPLOS.forEach((t, i) => {
        for (const off of COPIAS) {
          const p = mapa.latLngToContainerPoint([t.lat, t.lng + off]);
          const d = Math.hypot(p.x - punto.x, p.y - punto.y);
          if (d <= radio) { res.push({ m: t, d, lng: t.lng + off, tipo: "templo", i }); break; }
        }
      });
    }
    return res.sort((a, b) => a.d - b.d);
  }

  function abrirLugar(c) {
    if (c.tipo === "templo") return abrirPopupTemplo(c.i, c.lng);
    abrirPopupMision(c.m.id);
  }

  function abrirPopupTemplo(i, lng) {
    const t = TEMPLOS[i];
    // La misión más cercana al templo, como pista para adivinar
    let cerca = null;
    for (const m of MISIONES) { const d = km(t, m); if (!cerca || d < cerca.d) cerca = { m, d }; }
    L.popup({ maxWidth: 240 }).setLatLng([t.lat, lng === undefined ? lngCercana(t.lng) : lng])
      .setContent(`<strong>${esc(t.n)}</strong>${cerca ? `<br><span class="popup-sub">Misión más cercana:</span><br><button type="button" class="popup-enlace" data-ver="${cerca.m.id}">${esc(cerca.m.n)}</button>` : ""}`)
      .openOn(mapa);
  }

  // ---------- Templos (se cargan solo si alguien los activa) ----------
  let TEMPLOS = null;
  let capaTemplos = null;
  let verTemplos = store.get("ver_templos") === "1";
  async function mostrarTemplos(mostrar) {
    if (!mostrar) { if (capaTemplos) capaTemplos.remove(); return; }
    if (!TEMPLOS) {
      try {
        const r = await fetchT("data/templos.json", {}, 20);
        if (!r.ok) throw new Error("HTTP " + r.status);
        TEMPLOS = await r.json();
      } catch (err) {
        toast("No se pudieron cargar los templos. Intenta de nuevo.");
        verTemplos = false;
        const chk = $("chk-templos"); if (chk) chk.checked = false;
        return;
      }
      capaTemplos = L.layerGroup();
      const tactil = esTactil();
      TEMPLOS.forEach((t) => {
        for (const off of COPIAS) {
          L.circleMarker([t.lat, t.lng + off], {
            renderer: lienzo, interactive: false, radius: tactil ? 5 : 4, weight: 1.5,
            color: "#FFFFFF", fillColor: "#00A3E0", fillOpacity: 1,
          }).addTo(capaTemplos);
        }
      });
    }
    if (verTemplos) capaTemplos.addTo(mapa);
  }

  // ---------- Filtro de capas (esquina del mapa) ----------
  let verMisiones = store.get("ver_misiones") !== "0";
  function agregarFiltro() {
    const Filtro = L.Control.extend({
      options: { position: "topright" },
      onAdd() {
        const div = L.DomUtil.create("div", "filtro-mapa");
        div.innerHTML = `<p class="filtro-titulo">Mostrar</p>
          <label><input type="checkbox" id="chk-misiones" ${verMisiones ? "checked" : ""}> <span class="muestra muestra-mision"></span>Todas las misiones</label>
          <label><input type="checkbox" id="chk-templos" ${verTemplos ? "checked" : ""}> <span class="muestra muestra-templo"></span>Templos</label>`;
        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.disableScrollPropagation(div);
        div.querySelector("#chk-misiones").addEventListener("change", (e) => {
          verMisiones = e.target.checked;
          store.set("ver_misiones", verMisiones ? "1" : "0");
          if (verMisiones) capaBase.addTo(mapa); else capaBase.remove();
          mapa.closePopup();
        });
        div.querySelector("#chk-templos").addEventListener("change", (e) => {
          verTemplos = e.target.checked;
          store.set("ver_templos", verTemplos ? "1" : "0");
          mostrarTemplos(verTemplos);
          mapa.closePopup();
        });
        if (verTemplos) setTimeout(() => mostrarTemplos(true), 0);
        return div;
      },
    });
    const filtro = new Filtro().addTo(mapa);
    // En celular el cuadro tapa las ventanitas del mapa: se oculta mientras hay una abierta
    mapa.on("popupopen", () => { if (esCelular()) filtro.getContainer().classList.add("oculto"); });
    mapa.on("popupclose", () => filtro.getContainer().classList.remove("oculto"));
  }

  function abrirListaCerca(latlng, cerca) {
    const max = 8;
    const items = cerca.slice(0, max).map((c) => c.tipo === "templo"
      ? `<li><button type="button" data-templo="${c.i}" data-lng="${c.lng}"><span class="muestra muestra-templo"></span>${esc(c.m.n)}</button></li>`
      : `<li><button type="button" data-ver="${c.m.id}"><span class="muestra muestra-mision"></span>${esc(c.m.n)}</button></li>`).join("");
    const mas = cerca.length > max ? `<p class="mas">Hay ${cerca.length - max} más aquí. Acerca el mapa para verlos.</p>` : "";
    const titulo = cerca.every((c) => c.tipo === "mision") ? "¿Cuál misión?" : cerca.every((c) => c.tipo === "templo") ? "¿Cuál templo?" : "¿Cuál quieres ver?";
    L.popup({ maxWidth: 260 }).setLatLng(latlng)
      .setContent(`<strong>${titulo}</strong><ul class="lista-cerca">${items}</ul>${mas}`)
      .openOn(mapa);
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-ver]");
    if (b) abrirPopupMision(Number(b.dataset.ver));
    const t = e.target.closest("[data-templo]");
    if (t) abrirPopupTemplo(Number(t.dataset.templo), Number(t.dataset.lng));
  });

  let realCentrada = false;
  function centrarEnReal() {
    const real = datos.mision_real_id && POR_ID.get(datos.mision_real_id);
    if (!real || !mapa || realCentrada) return;
    realCentrada = true;
    mapa.setView([real.lat, lngCercana(real.lng)], 4);
  }

  function popupHtml(id) {
    const m = POR_ID.get(id);
    const quienes = prediccionesVisibles().filter((p) => p.m === id).map((p) => p.v);
    const unicos = [...new Set(quienes)];
    const ya = nombre ? prediccionesDe(nombre) : [];
    const puedeElegir = puedeVotar() && (!nombre || (ya.length < MAX_POR_PERSONA && !ya.includes(id)));
    let html = `<strong>${esc(m.n)}</strong><br><span>${esc(m.p)}</span>`;
    if (datos.mision_real_id === id) html += `<br><b>Esta es la misión real</b>`;
    html += unicos.length
      ? `<ul>${unicos.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`
      : `<br><em>Nadie la eligió todavía.</em>`;
    if (puedeElegir) html += `<button class="popup-btn" type="button" data-votar="${id}">Elegir esta misión</button>`;
    return html;
  }

  function abrirPopupMision(id) {
    const m = POR_ID.get(id);
    L.popup({ maxWidth: 240 }).setLatLng([m.lat, lngCercana(m.lng)]).setContent(popupHtml(id)).openOn(mapa);
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-votar]");
    if (!b) return;
    mapa.closePopup();
    const id = Number(b.dataset.votar);
    if (!nombre) { pendienteDesdeMapa = id; pedirNombre(); return; }
    abrirFormularioMision(id);
  });
  let pendienteDesdeMapa = null;
  $("form-nombre").addEventListener("submit", () => {
    if (pendienteDesdeMapa && nombre) { const id = pendienteDesdeMapa; pendienteDesdeMapa = null; setTimeout(() => abrirFormularioMision(id), 0); }
  });

  function pintarMapa() {
    if (!mapa) return;
    pintarLineas();
    capaPredicciones.clearLayers();
    const grupos = new Map();
    for (const p of prediccionesVisibles()) {
      if (!POR_ID.has(p.m)) continue;
      if (!grupos.has(p.m)) grupos.set(p.m, new Set());
      // Etiqueta corta: el apodo completo, o solo el primer nombre
      grupos.get(p.m).add(p.apodo ? p.v : p.v.split(" ")[0]);
    }
    for (const [id, set] of grupos) {
      const m = POR_ID.get(id);
      const nombres = [...set];
      const corto = (n) => n;
      const etiqueta = nombres.length <= 2 ? nombres.map(corto).join(", ") : `${corto(nombres[0])}, ${corto(nombres[1])} +${nombres.length - 2}`;
      const esReal = datos.mision_real_id === id;
      for (const off of COPIAS) {
        L.marker([m.lat, m.lng + off], {
          icon: L.divIcon({ className: "", html: `<div class="pin${esReal ? " real" : ""}"></div>`, iconSize: esReal ? [30, 30] : [22, 22], iconAnchor: esReal ? [4, 34] : [3, 25] }),
          zIndexOffset: esReal ? 1000 : nombres.length,
          title: m.n,
        }).bindTooltip(etiqueta, { permanent: true, direction: "top", offset: esReal ? [12, -34] : [8, -24], className: "etiqueta-pin" + (esReal ? " real" : "") })
          .on("click", () => abrirPopupMision(id))
          .addTo(capaPredicciones);
      }
    }
    const real = datos.mision_real_id && POR_ID.get(datos.mision_real_id);
    if (real && !grupos.has(real.id)) {
      for (const off of COPIAS) {
        L.marker([real.lat, real.lng + off], {
          icon: L.divIcon({ className: "", html: `<div class="pin real"></div>`, iconSize: [30, 30], iconAnchor: [4, 34] }),
          zIndexOffset: 1000,
        }).bindTooltip(real.n, { permanent: true, direction: "top", offset: [12, -34], className: "etiqueta-pin real" })
          .on("click", () => abrirPopupMision(real.id))
          .addTo(capaPredicciones);
      }
    }
  }

  function enfocarMision(id) {
    const m = POR_ID.get(id);
    if (!m || !mapa) return;
    mapa.setView([m.lat, lngCercana(m.lng)], 5);
    setTimeout(() => abrirPopupMision(id), 300);
  }

  // En el mapa se ven hasta 2 predicciones por persona
  function prediccionesVisibles() {
    return agruparPorPersona().flatMap((per) =>
      per.preds.slice(0, MAX_POR_PERSONA).map((p) => ({ ...p, v: per.visible, apodo: !!per.apodo })));
  }

  // ---------- Hoja deslizable (celular) ----------
  function abrirHoja(abrir) {
    const panel = $("panel");
    if (!panel) return;
    panel.classList.toggle("abierta", !!abrir);
    $("btn-hoja").setAttribute("aria-expanded", String(!!abrir));
  }
  $("btn-hoja").addEventListener("click", () => abrirHoja(!$("panel").classList.contains("abierta")));
  $("btn-barra-accion").addEventListener("click", (e) => {
    if (e.currentTarget.dataset.otra === "true") return empezarOtraPersona();
    if (KIOSKO) { nombre = ""; apodo = ""; }
    irAPrimerPaso();
  });

  // ---------- Panel: personas, ranking, avisos ----------
  function agruparPorPersona() {
    const personas = new Map();
    const ordenadas = [...datos.predicciones].sort((a, b) => a.f - b.f);
    for (const p of ordenadas) {
      const k = norm(p.n);
      if (!personas.has(k)) personas.set(k, { nombre: p.n, apodo: "", preds: [], vistos: new Set() });
      const per = personas.get(k);
      if (p.a) per.apodo = p.a;
      if (per.vistos.has(p.m)) continue; // misma misión repetida: no cuenta dos veces
      per.vistos.add(p.m);
      per.preds.push(p);
    }
    const lista = [...personas.values()];
    lista.forEach((per) => { per.visible = per.apodo || per.nombre; });
    return lista;
  }

  function pintarPanel() {
    const personas = agruparPorPersona();
    $("cuenta").textContent = personas.length ? `(${personas.length} ${personas.length === 1 ? "persona" : "personas"})` : "";
    $("personas").innerHTML = personas.length
      ? [...personas].reverse().map((per) => `<li class="persona"><div class="persona-nombre">${esc(per.visible)}${per.apodo && KIOSKO ? ` <small class="nombre-real">${esc(per.nombre)}</small>` : ""}</div><ol>${
        per.preds.map((p, i) => {
          const m = POR_ID.get(p.m);
          if (!m) return "";
          return `<li class="${i >= CUENTAN ? "extra" : ""}"><button type="button" data-ir="${m.id}">${esc(m.n)}</button>${i >= CUENTAN ? '<span class="etiqueta">(no cuenta para el premio)</span>' : ""}</li>`;
        }).join("")}</ol></li>`).join("")
      : `<li class="persona">Todavía no hay predicciones. ${puedeVotar() ? "¡Sé la primera persona en adivinar!" : ""}</li>`;

    // Avisos según el estado
    const aviso = $("aviso");
    aviso.className = "aviso";
    aviso.hidden = true;
    if (DEMO) { aviso.hidden = false; aviso.textContent = "Modo demo: las predicciones se guardan solo en este navegador. Pon la URL de Apps Script en js/config.js para compartirlas."; }
    if (datos.estado === "solo_kiosko" && !KIOSKO) { aviso.hidden = false; aviso.classList.add("cerrado"); aviso.textContent = "La votación en línea ya cerró. Ahora solo se vota en la reunión. Puedes seguir viendo el mapa."; }
    if (datos.estado === "cerrada") { aviso.hidden = false; aviso.classList.add("cerrado"); aviso.textContent = "La votación está cerrada. ¡Pronto sabremos la misión!"; }

    const hechas = nombre ? prediccionesDe(nombre).length : 0;
    const puedeAgregar = puedeVotar() && !KIOSKO && hechas < MAX_POR_PERSONA;
    $("btn-nueva").hidden = !puedeAgregar;
    $("btn-nueva").textContent = hechas ? "Agregar mi segunda predicción" : "Hacer mi predicción";
    $("btn-siguiente").hidden = !puedeVotar() || !KIOSKO;

    // Barra inferior (celular)
    const accion = $("btn-barra-accion");
    accion.hidden = !puedeVotar();
    accion.textContent = KIOSKO ? "Siguiente persona" : puedeAgregar ? (hechas ? "Agregar otra" : "Votar") : "Otra persona";
    accion.dataset.otra = String(!KIOSKO && !puedeAgregar);
    $("btn-otra-persona").hidden = !puedeVotar() || !!KIOSKO;
    const total = personas.reduce((t, per) => t + Math.min(per.preds.length, MAX_POR_PERSONA), 0);
    $("hoja-titulo").textContent = datos.estado === "revelado" ? "Ver ranking" : KIOSKO ? "Panel y lista" : "Ver predicciones";
    let sub = personas.length
      ? `${personas.length} ${personas.length === 1 ? "persona" : "personas"}, ${total} ${total === 1 ? "predicción" : "predicciones"}`
      : "Todavía no hay predicciones";
    if (datos.estado === "cerrada" || (datos.estado === "solo_kiosko" && !KIOSKO)) sub = "Votación cerrada. " + sub;
    const realSub = datos.mision_real_id && POR_ID.get(datos.mision_real_id);
    if (realSub) sub = `Irá a la Misión ${realSub.n}`;
    $("hoja-sub").textContent = sub;
    pintarRanking(personas);
    pintarControl();
  }

  // Ranking: la primera predicción de cada persona, ordenada por distancia a la misión real
  function calcularRanking(personas, real) {
    const filas = personas.map((per) => {
      let mejor = null;
      per.preds.slice(0, CUENTAN).forEach((p) => {
        const m = POR_ID.get(p.m);
        if (!m) return;
        const d = m.id === real.id ? 0 : km(m, real);
        if (!mejor || d < mejor.d) mejor = { d, m, f: p.f };
      });
      return mejor && { nombre: per.visible, real: per.apodo ? per.nombre : "", ...mejor };
    }).filter(Boolean);
    filas.sort((a, b) => a.d - b.d || a.f - b.f);
    return filas;
  }

  function pintarRanking(personas) {
    const real = datos.mision_real_id && POR_ID.get(datos.mision_real_id);
    $("ranking").hidden = !real;
    pintarRevelacion(real);
    if (!real) return;
    $("ranking-mision").textContent = "Para el premio cuenta solo la primera predicción de cada persona. Toca un nombre para ver su línea en el mapa.";
    const filas = calcularRanking(personas, real);
    $("ranking-lista").innerHTML = filas.map((r, i) => `<li data-linea="${i}" tabindex="0">
        <span class="pos">${i + 1}.</span>
        <span>${esc(r.nombre)}${r.real && KIOSKO ? ` <span class="nombre-real">(${esc(r.real)})</span>` : ""}<small>${esc(r.m.n)}</small></span>
        <span class="km ${r.d === 0 ? "exacto" : ""}">${r.d === 0 ? "¡Exacto!" : Math.round(r.d).toLocaleString("es") + " km"}</span>
      </li>`).join("");
  }

  function fechaLarga(iso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || "")) return "";
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("es", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  }

  function pintarRevelacion(real) {
    $("revelacion").hidden = !real;
    if (!real) return;
    const quien = (CFG.MISIONERO || "Nuestro misionero").split(" ")[0];
    $("rev-quien").textContent = `¡${quien} irá a la`;
    $("rev-mision").textContent = `Misión ${real.n}!`;
    $("rev-pais").textContent = real.p;
    const filas = [];
    if (datos.fecha) filas.push(["Fecha de salida", fechaLarga(datos.fecha) || datos.fecha]);
    if (datos.idioma) filas.push(["Idioma", datos.idioma]);
    $("rev-datos").innerHTML = filas.map(([t, v]) => `<div><dt>${esc(t)}</dt><dd>${esc(v)}</dd></div>`).join("");
  }

  // Líneas del ranking: de la primera predicción de cada persona a la misión real
  let lineas = [];
  function pintarLineas() {
    if (!capaLineas) return;
    capaLineas.clearLayers();
    lineas = [];
    const real = datos.mision_real_id && POR_ID.get(datos.mision_real_id);
    if (!real) return;
    calcularRanking(agruparPorPersona(), real).forEach((r, i) => {
      if (r.d === 0) { lineas.push(null); return; }
      // Tomar el camino corto si la línea cruzaría medio mundo (p. ej. de Asia a América)
      let lng = r.m.lng;
      while (lng - real.lng > 180) lng -= 360;
      while (real.lng - lng > 180) lng += 360;
      const top = i < 3;
      const estilo = {
        color: top ? "#005B94" : "#4B5E70", weight: top ? 3 : 1.5,
        opacity: top ? 0.9 : 0.55, dashArray: top ? null : "4 6",
      };
      // Una línea por cada copia del mundo, para que se vea igual al arrastrar el mapa hacia los lados
      const copias = COPIAS.map((off) => {
        const linea = L.polyline([[r.m.lat, lng + off], [real.lat, real.lng + off]], estilo)
          .bindTooltip(`${i + 1}. ${esc(r.nombre)}: ${Math.round(r.d).toLocaleString("es")} km`, { sticky: true })
          .addTo(capaLineas);
        linea.estilo = estilo;
        return linea;
      });
      lineas.push(copias);
    });
  }

  function resaltarLinea(i) {
    document.querySelectorAll("#ranking-lista li").forEach((li) => li.classList.toggle("activa", Number(li.dataset.linea) === i));
    lineas.forEach((grupo, j) => {
      if (!grupo) return;
      grupo.forEach((l) => {
        if (j === i) { l.setStyle({ color: "#00A3E0", weight: 5, opacity: 1, dashArray: null }); l.bringToFront(); }
        else l.setStyle(l.estilo);
      });
    });
    const real = datos.mision_real_id && POR_ID.get(datos.mision_real_id);
    abrirHoja(false);
    const grupo = lineas[i];
    if (grupo) {
      // La copia de la línea más cercana a lo que se está viendo
      const c = mapa.getCenter().lng;
      const l = grupo.slice().sort((a, b) => Math.abs(a.getCenter().lng - c) - Math.abs(b.getCenter().lng - c))[0];
      mapa.fitBounds(l.getBounds(), { padding: [50, 50], maxZoom: 11 });
      setTimeout(() => l.openTooltip(l.getCenter()), 350);
    } else if (real) mapa.setView([real.lat, lngCercana(real.lng)], 6);
  }

  $("ranking-lista").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-linea]");
    if (li) resaltarLinea(Number(li.dataset.linea));
  });
  $("ranking-lista").addEventListener("keydown", (e) => {
    const li = e.target.closest("li[data-linea]");
    if (li && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); resaltarLinea(Number(li.dataset.linea)); }
  });

  // ---------- Panel de control (solo en el kiosko) ----------
  const ESTADO_TXT = {
    abierta: "Abierta para todos",
    solo_kiosko: "Solo en esta computadora",
    cerrada: "Cerrada",
    revelado: "Misión revelada",
  };
  let realElegida = null;

  function pintarControl() {
    if (!KIOSKO) return;
    $("control").hidden = false;
    const real = datos.mision_real_id && POR_ID.get(datos.mision_real_id);
    $("estado-actual").textContent = (ESTADO_TXT[datos.estado] || datos.estado) + (real ? ": " + real.n : "");
    document.querySelectorAll(".btn-estado").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.estado === datos.estado)));
    $("btn-revelar").disabled = !realElegida;
  }

  function pintarRealElegida() {
    const caja = $("real-elegida");
    const buscador = $("real-buscar").parentElement;
    if (!realElegida) {
      caja.hidden = true; buscador.hidden = false; $("real-buscar").value = "";
      return;
    }
    buscador.hidden = true; caja.hidden = false;
    caja.innerHTML = `<div><strong>${esc(realElegida.n)}</strong><small>${esc(realElegida.p)}</small></div>
      <button type="button" class="btn-mini" id="btn-real-cambiar">Cambiar</button>`;
  }

  async function enviarControl(payload, mensajeOk) {
    $("error-control").textContent = "";
    const botones = document.querySelectorAll("#control button");
    botones.forEach((b) => { b.disabled = true; });
    try {
      const r = await api.admin(payload);
      if (!r.ok) {
        $("error-control").textContent = (r.error || "No se pudo aplicar el cambio.") +
          (r.codigo === "clave" ? ` Esta computadora tiene guardada la clave "${KIOSKO}". Abre la página con ?kiosko= y la clave exacta de la hoja.` : "");
        return;
      }
      datos.estado = r.estado;
      datos.mision_real_id = r.mision_real_id || null;
      if (r.fecha !== undefined) { datos.fecha = datos.estado === "revelado" ? r.fecha : datos.fecha; ponerDatosControl(r); }
      realCentrada = false;
      toast(mensajeOk);
      await cargarPredicciones();
    } catch (err) {
      $("error-control").textContent = "No hay conexión con el servidor. Intenta de nuevo.";
    } finally {
      botones.forEach((b) => { b.disabled = false; });
      pintarControl();
    }
  }

  function ponerDatosControl(r) {
    if (document.activeElement !== $("ctl-fecha")) $("ctl-fecha").value = r.fecha || "";
    if (document.activeElement !== $("ctl-idioma")) $("ctl-idioma").value = r.idioma || "";
  }
  const datosControl = () => ({ fecha: $("ctl-fecha").value || "", idioma: $("ctl-idioma").value.trim() });

  function iniciarControl() {
    if (!KIOSKO) return;
    // Al abrir: leer fecha e idioma guardados (y comprobar la clave desde el inicio)
    api.admin({}).then((r) => {
      if (r.ok) ponerDatosControl(r);
      else $("error-control").textContent = r.error + (r.codigo === "clave" ? ` Esta computadora tiene guardada la clave "${KIOSKO}".` : "");
    }).catch(() => {});
    $("btn-guardar-datos").addEventListener("click", () => enviarControl(datosControl(), "Fecha e idioma guardados"));
    conectarBuscador($("real-buscar"), $("real-sug"), "real", (m) => {
      realElegida = m; pintarRealElegida(); pintarControl();
    });
    $("control").addEventListener("click", (e) => {
      if (e.target.closest("#btn-real-cambiar")) {
        realElegida = null; pintarRealElegida(); pintarControl(); $("real-buscar").focus();
        return;
      }
      const b = e.target.closest("[data-estado]");
      if (!b) return;
      const estado = b.dataset.estado;
      if (estado === datos.estado) return;
      const confirmar = {
        cerrada: "¿Cerrar la votación? Nadie podrá votar, ni siquiera en esta computadora.",
        solo_kiosko: "¿Cerrar la votación en línea? Solo se podrá votar en esta computadora.",
        abierta: datos.estado === "revelado" ? "¿Ocultar el resultado y volver a abrir la votación para todos?" : "",
      }[estado];
      if (confirmar && !window.confirm(confirmar)) return;
      enviarControl({ estado }, "Votación: " + ESTADO_TXT[estado].toLowerCase());
    });
    $("btn-revelar").addEventListener("click", () => {
      if (!realElegida) return;
      if (!window.confirm(`¿Revelar que la misión es ${realElegida.n}? Todos verán el ranking y la votación se cerrará.`)) return;
      enviarControl({ estado: "revelado", mision_real_id: realElegida.id, ...datosControl() }, "¡Misión revelada!");
    });
    $("kiosko-chip").addEventListener("click", () => {
      mostrar("vista-mapa");
      if (esCelular()) { abrirHoja(true); $("hoja-contenido").scrollTop = 0; }
      else setTimeout(() => $("control").scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    });
  }

  $("personas").addEventListener("click", (e) => {
    const b = e.target.closest("[data-ir]");
    if (b) { abrirHoja(false); enfocarMision(Number(b.dataset.ir)); }
  });
  $("btn-nueva").addEventListener("click", irAPrimerPaso);
  $("btn-siguiente").addEventListener("click", () => { nombre = ""; apodo = ""; irAPrimerPaso(); });
  $("btn-otra-persona").addEventListener("click", empezarOtraPersona);
  $("btn-actualizar").addEventListener("click", async () => {
    const faltan = Math.ceil((Number(store.get("ultima_act") || 0) + ESPERA_SEG * 1000 - Date.now()) / 1000);
    if (!KIOSKO && faltan > 0) { toast(`La lista se actualiza sola. Puedes actualizar de nuevo en ${faltan} s.`); return; }
    store.set("ultima_act", String(Date.now()));
    await cargarPredicciones();
    toast("Lista actualizada");
  });

  // ---------- Carga de datos ----------
  let estadoAnterior = null;
  async function cargarPredicciones() {
    try {
      const r = await api.listar();
      if (r && r.ok) {
        datos = { estado: r.estado, mision_real_id: r.mision_real_id || null, fecha: r.fecha || "", idioma: r.idioma || "", predicciones: (r.predicciones || []).map((p) => ({ f: Number(p.f), n: String(p.n), m: Number(p.m), a: p.a ? String(p.a) : "" })) };
      }
    } catch (err) {
      toast("No se pudo actualizar la lista. Revisa tu conexión.");
    }
    pintarMapa();
    pintarPanel();
    centrarEnReal();
    revisarRevelado();
  }

  // Al revelarse la misión, en celular se abre la lista para mostrar el ranking (una sola vez)
  function revisarRevelado() {
    if ($("vista-mapa").hidden) return;
    if (datos.estado === "revelado" && estadoAnterior !== "revelado" && esCelular()) {
      abrirHoja(true);
      $("hoja-contenido").scrollTop = 0;
    }
    estadoAnterior = datos.estado;
  }

  function programarRefresco() {
    clearInterval(refrescoTimer);
    const seg = Math.max(20, Number(CFG.REFRESCO_SEG) || 60);
    refrescoTimer = setInterval(() => { if (!document.hidden) cargarPredicciones(); }, seg * 1000);
  }

  async function iniciar() {
    const placa = (CFG.MISIONERO || "").toUpperCase();
    $("placa-nombre").textContent = placa;
    $("titulo-mision").textContent = `¿A qué misión crees que irá ${CFG.MISIONERO || "nuestro misionero"}?`;
    $("kiosko-chip").hidden = !KIOSKO;
    if (!KIOSKO) { nombre = store.get("nombre") || ""; apodo = store.get("apodo") || ""; }

    if (typeof L === "undefined") {
      fallaCarga("No se pudo cargar la librería del mapa (Leaflet). Revisa tu conexión y recarga.");
      return;
    }
    try {
      const r = await fetchT("data/misiones.json", {}, 20);
      if (!r.ok) throw new Error("HTTP " + r.status);
      MISIONES = await r.json();
    } catch (e) {
      fallaCarga("No se pudo cargar la lista de misiones (data/misiones.json: " + e.message + "). Recarga la página.");
      return;
    }
    for (const m of MISIONES) {
      m._kn = norm(m.n);
      m._k = norm(m.n + " " + m.o + " " + m.p);
      POR_ID.set(m.id, m);
    }
    iniciarControl();
    await cargarPredicciones();

    const yaVoto = nombre && datos.predicciones.some((p) => norm(p.n) === norm(nombre));
    if (!puedeVotar() || yaVoto) mostrar("vista-mapa");
    else irAPrimerPaso();
  }

  iniciar();
})();
