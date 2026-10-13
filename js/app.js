(function () {
  "use strict";

  const CFG = window.APP_CONFIG || {};
  const MAX_OPCIONES = 3;
  const CUENTAN = 2; // predicciones por persona que cuentan para el premio

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
  let datos = { estado: "abierta", mision_real_id: null, predicciones: [] };
  let nombre = "";
  let elegidas = []; // [{id} | null] por cada campo de opción
  let mapa, capaPredicciones, capaBase;
  let refrescoTimer;

  // Modo kiosko: se activa abriendo la página con ?kiosko=CLAVE (queda guardado en ese navegador)
  const params = new URLSearchParams(location.search);
  if (params.has("kiosko")) {
    const v = params.get("kiosko");
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
      const r = await fetch(CFG.API_URL + "?t=" + Date.now(), { redirect: "follow" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    },
    async guardar(payload) {
      if (DEMO) return demo.guardar(payload);
      // text/plain evita la petición previa (CORS) que Apps Script no admite
      const r = await fetch(CFG.API_URL, { method: "POST", body: JSON.stringify(payload), redirect: "follow" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    },
  };
  const demo = {
    leer() { try { return JSON.parse(store.get("demo_pred") || "[]"); } catch (e) { return []; } },
    listar() {
      const estado = params.get("estado") || "abierta";
      return Promise.resolve({
        ok: true, estado,
        mision_real_id: estado === "revelado" ? Number(params.get("real")) || 366 : null,
        predicciones: demo.leer(),
      });
    },
    guardar(p) {
      const estado = params.get("estado") || "abierta";
      if (estado === "cerrada" || estado === "revelado") return Promise.resolve({ ok: false, error: "La votación ya está cerrada." });
      if (estado === "solo_kiosko" && !p.kiosko) return Promise.resolve({ ok: false, error: "La votación en línea ya cerró. Ahora solo se vota en la reunión." });
      const lista = demo.leer();
      const f = Date.now();
      p.misiones.forEach((m) => lista.push({ f, n: p.nombre, m: m.id }));
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
    window.scrollTo(0, 0);
    if (id === "vista-mapa") {
      iniciarMapa();
      setTimeout(() => { mapa.invalidateSize(); centrarEnReal(); }, 50);
      programarRefresco();
    } else {
      clearInterval(refrescoTimer);
    }
  }

  function irAPrimerPaso() {
    if (!puedeVotar()) return mostrar("vista-mapa");
    if (!nombre) { pedirNombre(); return; }
    abrirFormularioMision();
  }

  // Muestra el paso del nombre. En el kiosko siempre empieza vacío;
  // en un celular se rellena con lo último guardado para corregirlo fácil.
  function pedirNombre() {
    $("nombre").value = KIOSKO ? "" : (store.get("nombre_n") || "");
    $("apellido").value = KIOSKO ? "" : (store.get("nombre_a") || "");
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
    if (!KIOSKO) { store.set("nombre", nombre); store.set("nombre_n", n); store.set("nombre_a", a); }
    abrirFormularioMision();
  });

  $("btn-cambiar-nombre").addEventListener("click", () => {
    nombre = "";
    store.del("nombre");
    pedirNombre();
  });

  // ---------- Paso 2: misiones ----------
  function abrirFormularioMision(preseleccion) {
    elegidas = [preseleccion ? { id: preseleccion } : null];
    $("quien-nombre").textContent = nombre;
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
      const etiqueta = i === 0 ? "Tu predicción" : "Opción " + (i + 1);
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
        conectarBuscador(li.querySelector("input"), li.querySelector(".sugerencias"), i);
      }
      ol.appendChild(li);
    });
    $("btn-agregar-opcion").hidden = elegidas.length >= MAX_OPCIONES;
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
    if (elegidas.length >= MAX_OPCIONES) return;
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

  function conectarBuscador(input, lista, i) {
    let resultados = [];
    let activo = -1;
    const cerrar = () => { lista.hidden = true; input.setAttribute("aria-expanded", "false"); activo = -1; };
    const elegir = (m) => {
      if (elegidas.some((x, j) => j !== i && x && x.id === m.id)) {
        $("error-mision").textContent = "Ya elegiste esa misión en otra opción.";
        return;
      }
      $("error-mision").textContent = "";
      elegidas[i] = { id: m.id };
      pintarOpciones();
    };
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
    const btn = $("btn-guardar");
    btn.disabled = true; btn.textContent = "Guardando…";
    try {
      const r = await api.guardar({
        nombre,
        misiones: ids.map((id) => ({ id, n: POR_ID.get(id).n })),
        kiosko: KIOSKO,
        dispositivo: dispositivoId(),
      });
      if (!r.ok) {
        $("error-mision").textContent = r.error || "No se pudo guardar. Intenta de nuevo.";
        if (r.estado) { datos.estado = r.estado; }
        return;
      }
      toast(ids.length === 1 ? "¡Predicción guardada!" : `¡${ids.length} predicciones guardadas!`);
      await cargarPredicciones();
      mostrar("vista-mapa");
      enfocarMision(ids[0]);
    } catch (err) {
      $("error-mision").textContent = "No hay conexión con el servidor. Revisa tu internet e intenta de nuevo.";
    } finally {
      btn.disabled = false; btn.textContent = "Guardar mi predicción";
    }
  });

  $("btn-ver-mapa").addEventListener("click", () => mostrar("vista-mapa"));

  function dispositivoId() {
    let d = store.get("dispositivo");
    if (!d) { d = Math.random().toString(36).slice(2, 10); store.set("dispositivo", d); }
    return d;
  }

  // ---------- Mapa ----------
  function iniciarMapa() {
    if (mapa) return;
    mapa = L.map("mapa", { worldCopyJump: true, zoomControl: true, minZoom: 2 }).setView([10, -40], 2);
    // Fondo de mapa: OpenStreetMap (gratis, sin clave). Se puede cambiar en config.js.
    L.tileLayer(CFG.MAPA_URL || "https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: CFG.MAPA_CREDITO || '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(mapa);

    const lienzo = L.canvas({ padding: 0.5 });
    capaBase = L.layerGroup().addTo(mapa);
    for (const m of MISIONES) {
      L.circleMarker([m.lat, m.lng], {
        renderer: lienzo, radius: 3.5, weight: 1, color: "#5A6580", fillColor: "#FFFFFF", fillOpacity: 1,
      }).bindTooltip(m.n, { direction: "top" })
        .on("click", () => abrirPopupMision(m.id))
        .addTo(capaBase);
    }
    capaPredicciones = L.layerGroup().addTo(mapa);
    pintarMapa();
  }

  let realCentrada = false;
  function centrarEnReal() {
    const real = datos.mision_real_id && POR_ID.get(datos.mision_real_id);
    if (!real || !mapa || realCentrada) return;
    realCentrada = true;
    mapa.setView([real.lat, real.lng], 4);
  }

  function popupHtml(id) {
    const m = POR_ID.get(id);
    const quienes = datos.predicciones.filter((p) => p.m === id).map((p) => p.n);
    const unicos = [...new Set(quienes)];
    let html = `<strong>${esc(m.n)}</strong><br><span>${esc(m.p)}</span>`;
    if (datos.mision_real_id === id) html += `<br><b>Esta es la misión real</b>`;
    html += unicos.length
      ? `<ul>${unicos.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`
      : `<br><em>Nadie la eligió todavía.</em>`;
    if (puedeVotar()) html += `<button class="popup-btn" type="button" data-votar="${id}">Elegir esta misión</button>`;
    return html;
  }

  function abrirPopupMision(id) {
    const m = POR_ID.get(id);
    L.popup({ maxWidth: 240 }).setLatLng([m.lat, m.lng]).setContent(popupHtml(id)).openOn(mapa);
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
    capaPredicciones.clearLayers();
    const grupos = new Map();
    for (const p of datos.predicciones) {
      if (!POR_ID.has(p.m)) continue;
      if (!grupos.has(p.m)) grupos.set(p.m, new Set());
      grupos.get(p.m).add(p.n);
    }
    for (const [id, set] of grupos) {
      const m = POR_ID.get(id);
      const nombres = [...set];
      const corto = (n) => n.split(" ")[0];
      const etiqueta = nombres.length <= 2 ? nombres.map(corto).join(", ") : `${corto(nombres[0])}, ${corto(nombres[1])} +${nombres.length - 2}`;
      const esReal = datos.mision_real_id === id;
      L.marker([m.lat, m.lng], {
        icon: L.divIcon({ className: "", html: `<div class="pin${esReal ? " real" : ""}"></div>`, iconSize: esReal ? [30, 30] : [22, 22], iconAnchor: esReal ? [4, 34] : [3, 25] }),
        zIndexOffset: esReal ? 1000 : nombres.length,
        title: m.n,
      }).bindTooltip(etiqueta, { permanent: true, direction: "top", offset: esReal ? [12, -34] : [8, -24], className: "etiqueta-pin" + (esReal ? " real" : "") })
        .on("click", () => abrirPopupMision(id))
        .addTo(capaPredicciones);
    }
    const real = datos.mision_real_id && POR_ID.get(datos.mision_real_id);
    if (real && !grupos.has(real.id)) {
      L.marker([real.lat, real.lng], {
        icon: L.divIcon({ className: "", html: `<div class="pin real"></div>`, iconSize: [30, 30], iconAnchor: [4, 34] }),
        zIndexOffset: 1000,
      }).bindTooltip(real.n, { permanent: true, direction: "top", offset: [12, -34], className: "etiqueta-pin real" })
        .on("click", () => abrirPopupMision(real.id))
        .addTo(capaPredicciones);
    }
  }

  function enfocarMision(id) {
    const m = POR_ID.get(id);
    if (!m || !mapa) return;
    mapa.setView([m.lat, m.lng], 5);
    setTimeout(() => abrirPopupMision(id), 300);
  }

  // ---------- Panel: personas, ranking, avisos ----------
  function agruparPorPersona() {
    const personas = new Map();
    const ordenadas = [...datos.predicciones].sort((a, b) => a.f - b.f);
    for (const p of ordenadas) {
      const k = norm(p.n);
      if (!personas.has(k)) personas.set(k, { nombre: p.n, preds: [], vistos: new Set() });
      const per = personas.get(k);
      if (per.vistos.has(p.m)) continue; // misma misión repetida: no cuenta dos veces
      per.vistos.add(p.m);
      per.preds.push(p);
    }
    return [...personas.values()];
  }

  function pintarPanel() {
    const personas = agruparPorPersona();
    $("cuenta").textContent = personas.length ? `(${personas.length} ${personas.length === 1 ? "persona" : "personas"})` : "";
    $("personas").innerHTML = personas.length
      ? [...personas].reverse().map((per) => `<li class="persona"><div class="persona-nombre">${esc(per.nombre)}</div><ol>${
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
    if (datos.estado === "revelado") { aviso.hidden = false; aviso.textContent = "¡Ya se abrió la carta! Mira el ranking."; }

    $("btn-nueva").hidden = !puedeVotar() || !!KIOSKO;
    $("btn-siguiente").hidden = !puedeVotar() || !KIOSKO;
    pintarRanking(personas);
  }

  function pintarRanking(personas) {
    const real = datos.mision_real_id && POR_ID.get(datos.mision_real_id);
    $("ranking").hidden = !real;
    if (!real) return;
    $("ranking-mision").textContent = `La misión es ${real.n}. Cuentan las ${CUENTAN} primeras predicciones de cada persona; se toma la más cercana.`;
    const filas = personas.map((per) => {
      let mejor = null;
      per.preds.slice(0, CUENTAN).forEach((p) => {
        const m = POR_ID.get(p.m);
        if (!m) return;
        const d = m.id === real.id ? 0 : km(m, real);
        if (!mejor || d < mejor.d) mejor = { d, m, f: p.f };
      });
      return mejor && { nombre: per.nombre, ...mejor };
    }).filter(Boolean);
    filas.sort((a, b) => a.d - b.d || a.f - b.f);
    $("ranking-lista").innerHTML = filas.map((r, i) => `<li>
        <span class="pos">${i + 1}.</span>
        <span>${esc(r.nombre)}<small>${esc(r.m.n)}</small></span>
        <span class="km ${r.d === 0 ? "exacto" : ""}">${r.d === 0 ? "¡Exacto!" : Math.round(r.d).toLocaleString("es") + " km"}</span>
      </li>`).join("");
  }

  $("personas").addEventListener("click", (e) => {
    const b = e.target.closest("[data-ir]");
    if (b) { enfocarMision(Number(b.dataset.ir)); window.scrollTo({ top: 0, behavior: "smooth" }); }
  });
  $("btn-nueva").addEventListener("click", irAPrimerPaso);
  $("btn-siguiente").addEventListener("click", () => { nombre = ""; irAPrimerPaso(); });
  $("btn-actualizar").addEventListener("click", async () => { await cargarPredicciones(); toast("Lista actualizada"); });

  // ---------- Carga de datos ----------
  async function cargarPredicciones() {
    try {
      const r = await api.listar();
      if (r && r.ok) {
        datos = { estado: r.estado, mision_real_id: r.mision_real_id || null, predicciones: (r.predicciones || []).map((p) => ({ f: Number(p.f), n: String(p.n), m: Number(p.m) })) };
      }
    } catch (err) {
      toast("No se pudo actualizar la lista. Revisa tu conexión.");
    }
    pintarMapa();
    pintarPanel();
    centrarEnReal();
  }

  function programarRefresco() {
    clearInterval(refrescoTimer);
    const seg = Math.max(20, Number(CFG.REFRESCO_SEG) || 60);
    refrescoTimer = setInterval(() => { if (!document.hidden) cargarPredicciones(); }, seg * 1000);
  }

  async function iniciar() {
    const placa = (CFG.MISIONERO || "Élder").toUpperCase();
    $("placa-nombre").textContent = placa;
    $("titulo-mision").textContent = `¿A qué misión crees que irá ${CFG.MISIONERO || "nuestro misionero"}?`;
    $("kiosko-chip").hidden = !KIOSKO;
    if (!KIOSKO) nombre = store.get("nombre") || "";

    try {
      const r = await fetch("data/misiones.json");
      MISIONES = await r.json();
    } catch (e) {
      $("cargando").textContent = "No se pudo cargar la lista de misiones. Recarga la página.";
      return;
    }
    for (const m of MISIONES) {
      m._kn = norm(m.n);
      m._k = norm(m.n + " " + m.o + " " + m.p);
      POR_ID.set(m.id, m);
    }
    await cargarPredicciones();

    const yaVoto = nombre && datos.predicciones.some((p) => norm(p.n) === norm(nombre));
    if (!puedeVotar() || yaVoto) mostrar("vista-mapa");
    else irAPrimerPaso();
  }

  iniciar();
})();
