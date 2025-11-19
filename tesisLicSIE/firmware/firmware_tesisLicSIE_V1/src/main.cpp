#include <Arduino.h>              // Cabecera principal de Arduino para el framework de Arduino
#include <WiFi.h>                 // Librería para manejar WiFi en el ESP32
#include <WebServer.h>            // Librería para crear un servidor web sencillo
#include <SPIFFS.h>               // Librería para el sistema de archivos SPIFFS
#include <ArduinoJson.h>          // Librería para manejar JSON (lectura/escritura)

// =====================================================
// CONFIGURACIÓN WI-FI EN MODO AP
// =====================================================

WebServer server(80);             // Instancia del servidor web en el puerto 80

String apSSID;                    // Nombre (SSID) del Access Point
const char* apPassword = nullptr; // Contraseña del AP (nullptr => sin contraseña)

// =====================================================
// ARCHIVO DE ESTADO EN SPIFFS
// =====================================================

const char* STATE_FILE = "/state.json";  // Nombre del archivo JSON donde se guarda el estado

// =====================================================
// PINES DE PULSADORES (AJUSTAR SEGÚN EL HARDWARE REAL)
// =====================================================

// Pulsadores físicos para respuestas A–E
const int PIN_BTN_A = 32;        // Pin conectado al pulsador de la opción A
const int PIN_BTN_B = 33;        // Pin conectado al pulsador de la opción B
const int PIN_BTN_C = 25;        // Pin conectado al pulsador de la opción C
const int PIN_BTN_D = 26;        // Pin conectado al pulsador de la opción D
const int PIN_BTN_E = 27;        // Pin conectado al pulsador de la opción E

// Pulsador START (solo para iniciar el evaluativo, NO para confirmar respuestas)
const int PIN_BTN_START = 14;    // Pin conectado al pulsador de Start

// Pulsador RESET (para reiniciar cronómetro, lo interpreta el frontend)
const int PIN_BTN_RESET = 12;    // Pin conectado al pulsador de Reset

// Pulsador CANCEL (para cancelar la opción elegida, lo interpreta el frontend)
const int PIN_BTN_CANCEL = 13;   // Pin conectado al pulsador de Cancel

// =====================================================
// BUZZER (SALIDA DE AUDIO SIMPLE)
// =====================================================

const int PIN_BUZZER = 4;        // Pin conectado al buzzer activo o pasivo
const int BUZZER_CHANNEL = 0;    // Canal de PWM (LEDC) usado para el buzzer

// =====================================================
// ESTADO DE BOTONES (DETECCIÓN DE FLANCOS)
// =====================================================

// Estructura para guardar el estado de cada pulsador
struct ButtonState {
  int pin;           // Pin del ESP32 al que está conectado el pulsador
  bool lastLevel;    // Último nivel leído (para detección de cambios)
  const char* code;  // Código que se devolverá a la web: "A", "B", "C", "D", "E", "START", "RESET", "CANCEL"
};

// Array con todos los pulsadores que vamos a manejar
ButtonState buttons[] = {
  { PIN_BTN_A,     HIGH, "A" },       // Botón de respuesta A
  { PIN_BTN_B,     HIGH, "B" },       // Botón de respuesta B
  { PIN_BTN_C,     HIGH, "C" },       // Botón de respuesta C
  { PIN_BTN_D,     HIGH, "D" },       // Botón de respuesta D
  { PIN_BTN_E,     HIGH, "E" },       // Botón de respuesta E
  { PIN_BTN_START, HIGH, "START" },   // Botón Start (solo iniciar test)
  { PIN_BTN_RESET, HIGH, "RESET" },   // Botón Reset (reinicio de cronómetro)
  { PIN_BTN_CANCEL,HIGH, "CANCEL" }   // Botón Cancel (cancelar respuesta)
};

// Variables para reportar el último botón presionado al frontend
String lastButtonCode = "";           // Código del último pulsador presionado
uint32_t lastButtonEventId = 0;       // Contador incremental de eventos de botón

// =====================================================
// UTILIDADES GENERALES
// =====================================================

// Función para generar el SSID del AP como "ESP-XXXX" usando los últimos 2 bytes de la MAC
String getApSSID() {
  uint8_t mac[6];                                         // Buffer para almacenar la MAC
  esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);                 // Leemos la MAC del modo SoftAP
  char suffix[5];                                         // Sufijo de 4 caracteres hex
  sprintf(suffix, "%02X%02X", mac[4], mac[5]);            // Convertimos últimos 2 bytes a 4 dígitos hex
  return "ESP-" + String(suffix);                         // Devolvemos el SSID como "ESP-XXXX"
}

// Función para determinar el tipo de contenido (MIME type) según la extensión del archivo
String getContentType(const String& path) {
  if (path.endsWith(".html")) return "text/html";                         // Archivos HTML
  if (path.endsWith(".htm"))  return "text/html";                         // Archivos HTM
  if (path.endsWith(".css"))  return "text/css";                          // Hojas de estilo CSS
  if (path.endsWith(".js"))   return "application/javascript";            // Scripts JavaScript
  if (path.endsWith(".png"))  return "image/png";                         // Imágenes PNG
  if (path.endsWith(".jpg"))  return "image/jpeg";                        // Imágenes JPG
  if (path.endsWith(".jpeg")) return "image/jpeg";                        // Imágenes JPEG
  if (path.endsWith(".ico"))  return "image/x-icon";                      // Iconos
  if (path.endsWith(".svg"))  return "image/svg+xml";                     // Imágenes SVG
  if (path.endsWith(".txt"))  return "text/plain";                        // Archivos de texto plano
  if (path.endsWith(".json")) return "application/json";                  // Archivos JSON
  return "application/octet-stream";                                      // Tipo genérico por defecto
}

// =====================================================
// SERVIR ARCHIVOS DESDE SPIFFS
// =====================================================

// Función para servir un archivo desde SPIFFS según la ruta pedida
bool handleFileRead(const String& path) {
  String p = path;                                                       // Copiamos la ruta pedida

  if (p == "/") {                                                        // Si la ruta es "/", devolvemos index.html
    p = "/index.html";                                                   // Ruta real del archivo HTML principal
  }

  if (!SPIFFS.exists(p)) {                                               // Verificamos si el archivo existe en SPIFFS
    Serial.printf("[SPIFFS] Archivo no encontrado: %s\n", p.c_str());    // Mensaje de depuración si no existe
    return false;                                                        // Devolvemos false si no se encontró
  }

  File file = SPIFFS.open(p, "r");                                       // Abrimos el archivo en modo lectura
  if (!file) {                                                           // Comprobamos si se pudo abrir
    Serial.printf("[SPIFFS] Error abriendo archivo: %s\n", p.c_str());   // Mensaje de error al abrir
    return false;                                                        // Devolvemos false si hubo error
  }

  String contentType = getContentType(p);                                // Obtenemos el tipo MIME adecuado
  server.streamFile(file, contentType);                                  // Enviamos el archivo al cliente
  file.close();                                                          // Cerramos el archivo
  return true;                                                           // Indicamos que se sirvió correctamente
}

// =====================================================
// LECTURA/ESCRITURA DE state.json EN SPIFFS
// =====================================================

// Función que devuelve un JSON por defecto cuando no existe state.json
String getDefaultStateJson() {
  StaticJsonDocument<512> doc;                                           // Documento JSON en memoria

  JsonObject teacherConfig = doc.createNestedObject("teacherConfig");    // Objeto anidado para la configuración del docente
  teacherConfig["nombreDocente"] = "";                                   // Nombre del docente vacío
  teacherConfig["apellidoDocente"] = "";                                 // Apellido del docente vacío
  teacherConfig["curso"] = "";                                           // Curso vacío
  teacherConfig["division"] = "";                                        // División vacía
  teacherConfig["numQuestions"] = 0;                                     // Cantidad de preguntas en cero
  teacherConfig["timerMode"] = "up";                                     // Modo de cronómetro incremental
  teacherConfig["timerMinutes"] = 40;                                    // Minutos predeterminados para modo decremental

  doc["questionsTxt"] = "";                                              // Texto de preguntas vacío
  doc.createNestedArray("results");                                      // Array vacío de resultados

  JsonObject adminCreds = doc.createNestedObject("adminCreds");          // Credenciales de administrador por defecto
  adminCreds["user"] = "admin";                                          // Usuario admin por defecto
  adminCreds["pass"] = "admin0381";                                      // Contraseña admin por defecto

  String out;                                                            // Cadena donde se serializará el JSON
  serializeJson(doc, out);                                               // Serializamos el documento JSON a texto
  return out;                                                            // Devolvemos el JSON como String
}

// Función para leer el contenido de state.json desde SPIFFS
String loadStateJsonFromSPIFFS() {
  if (!SPIFFS.exists(STATE_FILE)) {                                      // Verificamos si el archivo state.json existe
    Serial.println("[STATE] state.json no existe, usando default.");     // Mensaje si no existe
    return getDefaultStateJson();                                        // Devolvemos JSON por defecto
  }

  File f = SPIFFS.open(STATE_FILE, "r");                                 // Abrimos el archivo de estado en modo lectura
  if (!f) {                                                              // Comprobamos si se abrió correctamente
    Serial.println("[STATE] Error abriendo state.json, usando default."); // Mensaje de error
    return getDefaultStateJson();                                        // Devolvemos JSON por defecto
  }

  String content = f.readString();                                       // Leemos todo el archivo como String
  f.close();                                                             // Cerramos el archivo

  if (content.length() == 0) {                                           // Si el archivo está vacío
    Serial.println("[STATE] state.json vacío, usando default.");         // Mensaje indicándolo
    return getDefaultStateJson();                                        // Devolvemos JSON por defecto
  }

  return content;                                                        // Devolvemos el contenido leído
}

// Función para guardar el JSON de estado en SPIFFS
bool saveStateJsonToSPIFFS(const String& jsonStr) {
  File f = SPIFFS.open(STATE_FILE, "w");                                 // Abrimos el archivo state.json en modo escritura
  if (!f) {                                                              // Comprobamos si se pudo abrir
    Serial.println("[STATE] Error abriendo state.json para escribir.");  // Mensaje de error
    return false;                                                        // Devolvemos false si hubo problema
  }
  size_t written = f.print(jsonStr);                                     // Escribimos el JSON en el archivo
  f.close();                                                             // Cerramos el archivo
  Serial.printf("[STATE] Guardado state.json (%u bytes)\n", (unsigned)written); // Mensaje de depuración con bytes escritos
  return true;                                                           // Indicamos que se guardó correctamente
}

// =====================================================
// HANDLERS HTTP
// =====================================================

// Handler para GET /api/state (devuelve el JSON de estado)
void handleApiStateGet() {
  String jsonStr = loadStateJsonFromSPIFFS();                            // Leemos el contenido de state.json o default
  server.send(200, "application/json", jsonStr);                         // Enviamos el JSON al cliente
}

// Handler para POST /api/state (guarda el JSON de estado)
void handleApiStatePost() {
  String body = server.arg("plain");                                     // Obtenemos el cuerpo de la petición (texto plano)
  if (body.isEmpty()) {                                                  // Verificamos si está vacío
    server.send(400, "application/json", "{\"error\":\"Body vacío\"}");  // Respondemos error 400 si no hay cuerpo
    return;                                                              // Salimos de la función
  }

  StaticJsonDocument<1024> doc;                                          // Documento JSON para validar sintaxis
  DeserializationError err = deserializeJson(doc, body);                 // Intentamos parsear el JSON recibido
  if (err) {                                                             // Si hubo error de parseo
    Serial.print("[STATE] Error parseando JSON: ");                      // Mostramos mensaje de error en la consola serial
    Serial.println(err.c_str());                                        // Mostramos detalle del error
    server.send(400, "application/json", "{\"error\":\"JSON inválido\"}"); // Respondemos con error 400
    return;                                                              // Salimos
  }

  if (!saveStateJsonToSPIFFS(body)) {                                    // Intentamos guardar el JSON en el archivo
    server.send(500, "application/json", "{\"error\":\"No se pudo guardar\"}"); // Error 500 si falla el guardado
    return;                                                              // Salimos
  }

  server.send(200, "application/json", "{\"ok\":true}");                 // Respondemos que todo salió bien
}

// Handler para GET /api/last_button (devuelve el último botón pulsado)
void handleApiLastButton() {
  StaticJsonDocument<128> doc;                                           // Documento JSON para la respuesta
  doc["button"] = lastButtonCode;                                        // Guardamos el código del último botón
  doc["eventId"] = lastButtonEventId;                                    // Guardamos el ID del evento

  String out;                                                            // Cadena para serializar el JSON
  serializeJson(doc, out);                                               // Serializamos JSON a String
  server.send(200, "application/json", out);                             // Enviamos la respuesta al cliente
}

// =====================================================
// BUZZER: FUNCIONES DE SONIDO
// =====================================================

// Función para configurar el buzzer con PWM (LEDC)
void setupBuzzer() {
  ledcSetup(BUZZER_CHANNEL, 2000, 8);                                    // Configuramos canal con frecuencia base 2 kHz y resolución de 8 bits
  ledcAttachPin(PIN_BUZZER, BUZZER_CHANNEL);                             // Asociamos el pin del buzzer al canal de PWM
  ledcWrite(BUZZER_CHANNEL, 0);                                          // Iniciamos el canal con duty 0 (silencio)
}

// Función auxiliar para emitir un tono de cierta frecuencia y duración
void buzzerTone(int freq, int ms) {
  ledcWriteTone(BUZZER_CHANNEL, freq);                                   // Establecemos la frecuencia en el canal
  delay(ms);                                                             // Mantenemos el tono durante la cantidad de milisegundos indicada
  ledcWriteTone(BUZZER_CHANNEL, 0);                                      // Apagamos el tono (frecuencia 0)
}

// Patrón de sonido para respuesta correcta
void buzzerCorrecto() {
  buzzerTone(2000, 150);                                                 // Primer beep agudo corto
  delay(50);                                                             // Pausa breve entre beeps
  buzzerTone(2500, 150);                                                 // Segundo beep más agudo
}

// Patrón de sonido para respuesta incorrecta
void buzzerIncorrecto() {
  buzzerTone(400, 250);                                                  // Beep grave más largo indicando error
}

// Patrón de sonido para felicitaciones (aprobado)
void buzzerAprobado() {
  buzzerTone(1500, 200);                                                 // Primera nota
  delay(60);                                                             // Pequeña pausa
  buzzerTone(1800, 200);                                                 // Segunda nota
  delay(60);                                                             // Pequeña pausa
  buzzerTone(2100, 300);                                                 // Tercera nota más larga (final)
}

// Handler para POST /api/buzzer (el frontend pide que suene un patrón)
void handleApiBuzzer() {
  String body = server.arg("plain");                                     // Leemos el cuerpo de la petición
  String tipo = "";                                                      // Variable para almacenar el tipo de sonido

  if (body.length() > 0) {                                               // Si hay contenido en el cuerpo
    StaticJsonDocument<128> doc;                                         // Documento JSON para parsear
    DeserializationError err = deserializeJson(doc, body);               // Intentamos parsear el JSON
    if (!err) {                                                          // Si se parseó correctamente
      tipo = (const char*)doc["tipo"];                                   // Extraemos el campo "tipo"
    }
  }

  if (tipo == "") {                                                      // Si aún no tenemos tipo
    tipo = server.arg("tipo");                                           // Intentamos obtenerlo como parámetro de URL o formulario
  }

  if (tipo == "correcto") {                                              // Si el tipo es "correcto"
    buzzerCorrecto();                                                    // Reproducimos patrón de respuesta correcta
  } else if (tipo == "incorrecto") {                                     // Si el tipo es "incorrecto"
    buzzerIncorrecto();                                                  // Reproducimos patrón de respuesta incorrecta
  } else if (tipo == "aprobado") {                                       // Si el tipo es "aprobado"
    buzzerAprobado();                                                    // Reproducimos patrón de felicitaciones
  } else {                                                               // Si no coincide con ninguno
    server.send(400, "application/json", "{\"error\":\"tipo inválido\"}"); // Respondemos con error 400
    return;                                                              // Salimos
  }

  server.send(200, "application/json", "{\"ok\":true}");                 // Respondemos que se ejecutó el sonido
}

// Handler por defecto para rutas que no coinciden (sirve archivos o 404)
void handleNotFound() {
  String path = server.uri();                                            // Obtenemos la ruta solicitada
  if (handleFileRead(path)) {                                            // Intentamos servir un archivo desde SPIFFS
    return;                                                              // Si se sirvió, salimos
  }
  server.send(404, "text/plain", "404 Not Found");                       // Si no existe archivo, devolvemos 404 texto plano
}

// =====================================================
// INICIALIZACIÓN DE PULSADORES
// =====================================================

// Función para configurar todos los pines de los pulsadores
void setupButtons() {
  for (size_t i = 0; i < sizeof(buttons) / sizeof(buttons[0]); i++) {    // Recorremos el array de botones
    pinMode(buttons[i].pin, INPUT_PULLUP);                               // Configuramos cada pin como entrada con resistencia pull-up interna
    buttons[i].lastLevel = digitalRead(buttons[i].pin);                  // Guardamos el nivel inicial del pin
  }
}

// Función para leer el estado de los pulsadores y detectar pulsaciones
void pollButtons() {
  for (size_t i = 0; i < sizeof(buttons) / sizeof(buttons[0]); i++) {    // Recorremos todos los pulsadores
    bool level = digitalRead(buttons[i].pin);                            // Leemos el nivel actual del pin
    if (buttons[i].lastLevel == HIGH && level == LOW) {                  // Detectamos flanco de bajada (HIGH -> LOW) = pulsación
      lastButtonCode = buttons[i].code;                                  // Guardamos el código del botón presionado
      lastButtonEventId++;                                               // Incrementamos el ID de evento
      Serial.printf("[BTN] Pulsado: %s (eventId=%lu)\n",                 // Mostramos por Serial qué botón se pulsó
                    buttons[i].code,
                    (unsigned long)lastButtonEventId);
      delay(20);                                                         // Pequeño debounce por software
    }
    buttons[i].lastLevel = level;                                        // Actualizamos el último nivel leído
  }
}

// =====================================================
// SETUP
// =====================================================

void setup() {
  Serial.begin(115200);                                                  // Iniciamos la comunicación serie a 115200 baudios
  delay(1000);                                                           // Pequeña espera para estabilizar
  Serial.println();                                                      // Imprimimos una línea en blanco
  Serial.println("=== QUIZ ESP32 AP + SPIFFS + WebServer ===");         // Mensaje de inicio del firmware

  if (!SPIFFS.begin(true)) {                                             // Intentamos montar SPIFFS (formateando si falla)
    Serial.println("[SPIFFS] Error montando SPIFFS");                    // Mensaje de error si no se pudo montar
  } else {
    Serial.println("[SPIFFS] Montado correctamente");                    // Mensaje de éxito si se montó
    File root = SPIFFS.open("/");                                        // Abrimos la raíz del sistema de archivos
    File file = root.openNextFile();                                     // Obtenemos el primer archivo
    Serial.println("[SPIFFS] Archivos encontrados:");                    // Encabezado de listado
    while (file) {                                                       // Mientras haya archivos
      Serial.printf("  %s (%u bytes)\n", file.name(), (unsigned)file.size()); // Mostramos nombre y tamaño
      file = root.openNextFile();                                       // Avanzamos al siguiente archivo
    }
  }

  apSSID = getApSSID();                                                  // Obtenemos el SSID dinámico basado en la MAC
  Serial.printf("[WIFI] Iniciando AP: %s\n", apSSID.c_str());            // Mostramos el SSID por consola
  WiFi.mode(WIFI_AP);                                                    // Ponemos el WiFi en modo Access Point
  bool apOk = WiFi.softAP(apSSID.c_str(), apPassword);                   // Iniciamos el AP con el SSID y sin contraseña
  if (!apOk) {                                                           // Verificamos si se inició correctamente
    Serial.println("[WIFI] Error iniciando AP");                         // Mensaje de error si falló
  } else {
    IPAddress ip = WiFi.softAPIP();                                      // Obtenemos la IP del AP
    Serial.print("[WIFI] AP IP: ");                                      // Texto de información
    Serial.println(ip);                                                  // Mostramos la IP en consola
  }

  setupButtons();                                                        // Configuramos los pines de pulsadores
  setupBuzzer();                                                         // Configuramos el buzzer y su canal PWM

  server.on("/api/state", HTTP_GET, handleApiStateGet);                  // Ruta GET /api/state para leer estado
  server.on("/api/state", HTTP_POST, handleApiStatePost);                // Ruta POST /api/state para guardar estado
  server.on("/api/last_button", HTTP_GET, handleApiLastButton);          // Ruta GET /api/last_button para último botón
  server.on("/api/buzzer", HTTP_POST, handleApiBuzzer);                  // Ruta POST /api/buzzer para sonidos del buzzer

  server.onNotFound(handleNotFound);                                     // Handler para cualquier otra ruta no definida

  server.begin();                                                        // Iniciamos el servidor web
  Serial.println("[HTTP] Servidor web iniciado en el puerto 80");        // Mensaje de confirmación
}

// =====================================================
// LOOP PRINCIPAL
// =====================================================

void loop() {
  server.handleClient();                                                 // Atendemos peticiones HTTP entrantes
  pollButtons();                                                         // Leemos el estado de los pulsadores en cada ciclo
}
