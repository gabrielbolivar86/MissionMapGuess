// Configuración de la página. Es lo único que necesitas editar.
window.APP_CONFIG = {
  // URL de tu Apps Script (termina en /exec). Si la dejas vacía, la página
  // funciona en "modo demo": guarda las predicciones solo en este navegador.
  API_URL: "https://script.google.com/macros/s/AKfycbyLCAX1mBlJwAWXVT4BdcpQgRG75_8VJP5ivrOvFC_OU-0mFSHhKKU6EfELMlUxFb5A/exec",

  // Nombre que aparece en la placa del encabezado.
  MISIONERO: "Samuel Bolivar",

  // Cada cuántos segundos se refresca la lista de predicciones en el mapa.
  REFRESCO_SEG: 60,

  // Punto de partida para "la misión más lejana" en las estadísticas (la casa del misionero).
  ORIGEN: { nombre: "La Paz, Bolivia", pais: "Bolivia", lat: -16.5, lng: -68.15 },

  // ID de la misión donde vive (de misiones.csv). No se puede elegir: no lo asignan a su propia misión.
  MISION_PROPIA: 44, // Bolivia La Paz

  // Fondo del mapa. Vacío = OpenStreetMap (gratis, sin clave ni cuenta).
  // Para usar otro proveedor pega aquí su URL de tiles y su texto de crédito.
  MAPA_URL: "",
  MAPA_CREDITO: "",
};
