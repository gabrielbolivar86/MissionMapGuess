// Configuración de la página. Es lo único que necesitas editar.
window.APP_CONFIG = {
  // URL de tu Apps Script (termina en /exec). Si la dejas vacía, la página
  // funciona en "modo demo": guarda las predicciones solo en este navegador.
  API_URL: "https://script.google.com/macros/s/AKfycbyLCAX1mBlJwAWXVT4BdcpQgRG75_8VJP5ivrOvFC_OU-0mFSHhKKU6EfELMlUxFb5A/exec",

  // Nombre que aparece en la placa del encabezado.
  MISIONERO: "Samuel Bolivar",

  // Cada cuántos segundos se refresca la lista de predicciones en el mapa.
  REFRESCO_SEG: 60,

  // Fondo del mapa. Vacío = OpenStreetMap (gratis, sin clave ni cuenta).
  // Para usar otro proveedor pega aquí su URL de tiles y su texto de crédito.
  MAPA_URL: "",
  MAPA_CREDITO: "",
};
