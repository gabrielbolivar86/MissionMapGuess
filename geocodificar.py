"""
Llena las columnas lat y lng de data/misiones.csv usando Nominatim (OpenStreetMap).

Uso (desde la carpeta MissionMapGuess):
    python geocodificar.py

- Respeta el límite de Nominatim: 1 consulta por segundo (~9 minutos para 504 misiones).
- Guarda el resultado en data/misiones_geo.csv a medida que avanza.
- Si se corta, vuelve a correrlo: retoma donde se quedó (salta las filas que ya tienen coordenadas).
- Solo usa la librería estándar de Python, no hay que instalar nada.
"""
import csv
import json
import os
import time
import urllib.parse
import urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
ENTRADA = os.path.join(BASE, "data", "misiones.csv")
SALIDA = os.path.join(BASE, "data", "misiones_geo.csv")

# Nominatim exige un User-Agent que identifique tu app (con un contacto).
USER_AGENT = "MissionMapGuess/1.0 (proyecto personal; contacto: gabrielbolivar86@gmail.com)"
URL = "https://nominatim.openstreetmap.org/search"


def consultar(params):
    params = {**params, "format": "json", "limit": 1}
    req = urllib.request.Request(
        URL + "?" + urllib.parse.urlencode(params),
        headers={"User-Agent": USER_AGENT, "Accept-Language": "es"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        datos = json.loads(r.read().decode("utf-8"))
    time.sleep(1.1)  # límite de 1 consulta por segundo
    if datos:
        return float(datos[0]["lat"]), float(datos[0]["lon"])
    return None


def geocodificar(fila):
    ciudad, region, codigo = fila["ciudad"], fila["region"], fila["codigo_pais"]
    intentos = []
    # 1) Búsqueda estructurada: ciudad (+ estado en EE. UU.) dentro del país
    p = {"city": ciudad, "countrycodes": codigo}
    if region:
        p["state"] = region
    intentos.append(p)
    # 2) Búsqueda libre por si "ciudad" no es una ciudad formal (p. ej. Interlagos, El Alto)
    intentos.append({"q": ", ".join(x for x in [ciudad, region] if x), "countrycodes": codigo})
    for p in intentos:
        try:
            r = consultar(p)
            if r:
                return r
        except Exception as e:
            print(f"   error: {e}; reintento en 5 s")
            time.sleep(5)
    return None


def main():
    origen = SALIDA if os.path.exists(SALIDA) else ENTRADA
    with open(origen, encoding="utf-8", newline="") as f:
        filas = list(csv.DictReader(f))
    columnas = list(filas[0].keys())

    pendientes = [f for f in filas if not f["lat"]]
    print(f"{len(filas)} misiones, {len(pendientes)} por geocodificar.")

    for i, fila in enumerate(pendientes, 1):
        r = geocodificar(fila)
        if r:
            fila["lat"], fila["lng"] = f"{r[0]:.5f}", f"{r[1]:.5f}"
            print(f"[{i}/{len(pendientes)}] OK  {fila['nombre_es']} -> {fila['lat']}, {fila['lng']}")
        else:
            fila["revisar"] = "sí (sin resultado, poner a mano)"
            print(f"[{i}/{len(pendientes)}] ??  {fila['nombre_es']} (sin resultado)")
        # guardar cada 10 filas para no perder avance
        if i % 10 == 0 or i == len(pendientes):
            with open(SALIDA, "w", encoding="utf-8", newline="") as f:
                w = csv.DictWriter(f, fieldnames=columnas)
                w.writeheader()
                w.writerows(filas)

    sin = [f["nombre_es"] for f in filas if not f["lat"]]
    print(f"\nListo. Guardado en {SALIDA}")
    if sin:
        print(f"{len(sin)} sin coordenadas (revisar a mano):")
        for n in sin:
            print("  -", n)


if __name__ == "__main__":
    main()
