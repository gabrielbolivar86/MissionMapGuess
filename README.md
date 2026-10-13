# ¿A dónde irá? — Mapa de predicciones de misión

Página para que familia y amigos adivinen a qué misión irá un futuro misionero.
Las predicciones se guardan en una Google Sheet (vía Apps Script) y se ven como pines en un mapa.

## Estructura

```
index.html            Página
css/styles.css        Estilos (móvil y computadora)
js/config.js          ← lo único que editas: URL de Apps Script y nombre del misionero
js/app.js             Lógica (formulario, mapa, ranking)
data/misiones.json    505 misiones con coordenadas (lo usa la página)
data/misiones.csv     Lista base (sin coordenadas)
data/misiones_geo.csv Lista con coordenadas (salida de geocodificar.py)
apps-script/Code.gs   Backend para pegar en Apps Script
geocodificar.py       Script que llenó las coordenadas (no hace falta volver a correrlo)
```

## Probar en tu computadora

Con `API_URL` vacío en `js/config.js`, la página funciona en **modo demo** (guarda solo en tu navegador).

```
python -m http.server 8000
```

Abre http://localhost:8000. Para simular estados: `?estado=solo_kiosko`, `?estado=cerrada`,
`?estado=revelado&real=366` (366 = Perú Lima Este).

## 1. Google Sheet + Apps Script

1. Crea una Google Sheet nueva.
2. **Extensiones → Apps Script**. Borra lo que haya y pega `apps-script/Code.gs`. Guarda.
3. Elige la función `configurar` y pulsa **Ejecutar**. Acepta los permisos.
   Se crean las pestañas `Predicciones` y `Config`.
4. **Implementar → Nueva implementación → Aplicación web**
   - Ejecutar como: **Yo**
   - Quién tiene acceso: **Cualquier persona**
5. Copia la URL que termina en `/exec` y pégala en `API_URL` dentro de `js/config.js`.

> Si cambias el código de Apps Script después, usa **Implementar → Gestionar implementaciones → Editar → Versión nueva**
> para mantener la misma URL.

## 2. Publicar en GitHub Pages

1. Sube esta carpeta a un repositorio público en GitHub.
2. **Settings → Pages → Source: Deploy from a branch → main / (root)**.
3. En un par de minutos la página estará en `https://TU-USUARIO.github.io/NOMBRE-DEL-REPO/`.

## Control durante el evento

Desde la computadora del kiosko, toca **Panel de control** (arriba). Ahí puedes abrir o cerrar la votación,
dejar votar solo a esa computadora, y elegir la misión real para revelar el ranking. No hace falta abrir la hoja.

También se puede hacer a mano en la pestaña Config de la hoja:

| estado        | Qué pasa |
|---------------|----------|
| `abierta`     | Cualquiera puede votar. |
| `solo_kiosko` | Solo vota la computadora de la reunión. Los demás ven el mapa. |
| `cerrada`     | Nadie vota. Todos ven el mapa. |
| `revelado`    | Muestra el ranking. Antes pon el ID de la misión real en `mision_real_id`. |

Los cambios se reflejan en la página en unos 15 segundos.

**Computadora de la reunión (kiosko):** abre una vez la página con `?kiosko=CLAVE`
(la clave está en `Config → clave_kiosko`). Ese navegador queda marcado: no recuerda nombres
y después de cada voto muestra **Siguiente persona**. Para quitarlo, abre la página con `?kiosko=`.

**Si el panel dice que la clave no coincide:** en Apps Script elige la función `nuevaClaveKiosko` y pulsa
**Ejecutar**. Crea una clave nueva (solo letras) en Config y la muestra en el registro. Luego abre en el kiosko
la página con `?kiosko=` y esa clave nueva.

## Revelar la misión

En el panel de control del kiosko:
1. (Opcional) Pon la **fecha de salida** y el **idioma** y toca "Guardar fecha e idioma". Nadie más los ve todavía.
2. Elige la **misión real** y toca "Revelar misión y ranking" (también guarda la fecha y el idioma si los llenaste).

Todos ven una tarjeta grande con la misión, la fecha y el idioma, el ranking, y en el mapa una línea desde
la primera predicción de cada persona hasta la misión real (las 3 más cercanas, más marcadas).
Al tocar un nombre del ranking se resalta su línea.

## Apodos

Debajo del apellido hay un enlace discreto "¿Quieres agregar tu apodo?". Si alguien pone un apodo, en el mapa,
la lista y el ranking se ve el apodo en lugar del nombre. En el kiosko se ve también el nombre real.
El límite de predicciones y la espera siguen usando el nombre y apellido.

## Reglas del ranking

- Cada persona puede hacer **máximo 2 predicciones** (juntas o una y luego otra). Apps Script lo valida
  por nombre y apellido, así que no se puede saltar el límite.
- Para el premio **solo cuenta la primera predicción** de cada persona (por hora de envío).
- Una misma persona debe esperar 1 minuto entre envíos, y el botón Actualizar se puede usar 1 vez por minuto.
  El kiosko no tiene esta espera.
- Desde cualquier celular se puede **enviar la predicción de otra persona** (botón en la lista), sin perder el nombre propio.
- El ranking se ordena por distancia en línea recta (km) entre esa primera predicción y la misión real.
- Acertar la misión exacta = 0 km. Empates: gana quien votó primero.
- Las personas se identifican por su nombre y apellido (sin importar tildes ni mayúsculas).
- Las misiones de una misma ciudad (p. ej. Lima Norte y Lima Este) están separadas unos km en el mapa
  según su dirección, así que en el ranking se distinguen, pero la distancia entre ellas es aproximada.
