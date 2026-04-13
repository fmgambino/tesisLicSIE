/****************************************************
 * ARCADE-QUIZ
 * Proyecto: Recurso Educativo Interactivo Aplicando Sistemas de Inteligencia Embebida
 * by Ing. Gambino, Fernando - NOV 2025
 *
 ****************************************************/
#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <WiFiManager.h>
#include <ESPmDNS.h>
#include <LittleFS.h>
#include <ArduinoJson.h>

// =====================================================
// CONFIG
// =====================================================
static const char* MDNS_NAME = "arcadequiz";      // http://arcadequiz.local/
static const char* STATE_FILE = "/state.json";

// ---- Pines (AJUSTAR si tu cableado usa otros) ----
// INPUT_PULLUP => pulsado = LOW
// Mapeo pedido: Rojo=A, Verde=B, Amarillo=C, Blanco=D, Azul=E
static const uint8_t PIN_BTN_A_RED     = 25; // Rojo -> A
static const uint8_t PIN_BTN_B_GREEN   = 26; // Verde -> B
static const uint8_t PIN_BTN_C_YELLOW  = 27; // Amarillo -> C
static const uint8_t PIN_BTN_D_WHITE   = 33; // Blanco -> D
static const uint8_t PIN_BTN_E_BLUE    = 32; // Azul -> E

static const uint8_t PIN_BTN_START     = 14; // btn_start físico -> "START"
static const uint8_t PIN_BTN_CANCEL    = 16; // rojo cancelar   -> "CANCEL"
static const uint8_t PIN_BTN_ACCEPT    = 17; // verde aceptar   -> "ACCEPT" (confirma)

static const uint8_t PIN_BUZZER        = 4;  // buzzer (pasivo recomendado)
static const uint8_t BUZZER_CH         = 0;  // canal LEDC

static const uint32_t DEBOUNCE_MS      = 40;
static const uint32_t ACCEPT_WINDOW_MS = 8000; // aceptar válido luego de elegir A-E

// =====================================================
// GLOBALS
// =====================================================
WebServer server(80);
static String g_stateJson = "{}";

// /api/last_button
static volatile uint32_t g_eventId = 0;
static String g_lastButton = "";

// Para aceptar sin tocar tu JS: re-emitir última letra A-E
static String g_lastSelectedLetter = "";
static uint32_t g_lastSelectedMs = 0;

// =====================================================
// HELPERS
// =====================================================
static void pushEvent(const String& code) {
  g_eventId++;
  g_lastButton = code;
}

static void sendNoCache() {
  server.sendHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  server.sendHeader("Pragma", "no-cache");
  server.sendHeader("Expires", "0");
}

static String contentType(const String& path) {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".css"))  return "text/css; charset=utf-8";
  if (path.endsWith(".js"))   return "application/javascript; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".png"))  return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".svg"))  return "image/svg+xml";
  if (path.endsWith(".ico"))  return "image/x-icon";
  return "text/plain; charset=utf-8";
}

static bool serveFile(const String& uri) {
  String p = uri;
  if (p == "/") p = "/index.html";
  if (!LittleFS.exists(p)) return false;

  File f = LittleFS.open(p, "r");
  if (!f) return false;

  sendNoCache();
  server.streamFile(f, contentType(p));
  f.close();
  return true;
}

// =====================================================
// AP SSID: ARCADE-QUIZ + last4(MAC)
// =====================================================
static String macSuffix4() {
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);
  char suf[5];
  snprintf(suf, sizeof(suf), "%02X%02X", mac[4], mac[5]);
  return String(suf);
}
static String buildApSsid() {
  return String("ARCADE-QUIZ") + macSuffix4();
}

// =====================================================
// STATE DEFAULT + LOAD/SAVE
// =====================================================
static String defaultStateJson() {
  StaticJsonDocument<768> doc;

  JsonObject teacherConfig = doc.createNestedObject("teacherConfig");
  teacherConfig["nombreDocente"] = "";
  teacherConfig["apellidoDocente"] = "";
  teacherConfig["curso"] = "";
  teacherConfig["division"] = "";
  teacherConfig["numQuestions"] = 0;
  teacherConfig["timerMode"] = "up";
  teacherConfig["timerMinutes"] = 40;

  doc["questionsTxt"] = "";
  doc.createNestedArray("results");

  JsonObject adminCreds = doc.createNestedObject("adminCreds");
  adminCreds["user"] = "admin";
  adminCreds["pass"] = "admin0381";

  String out;
  serializeJson(doc, out);
  return out;
}

static void loadState() {
  if (!LittleFS.exists(STATE_FILE)) {
    g_stateJson = defaultStateJson();
    return;
  }
  File f = LittleFS.open(STATE_FILE, "r");
  if (!f) {
    g_stateJson = defaultStateJson();
    return;
  }
  String s = f.readString();
  f.close();
  g_stateJson = (s.length() ? s : defaultStateJson());
}

static bool saveState(const String& json) {
  File f = LittleFS.open(STATE_FILE, "w");
  if (!f) return false;
  f.print(json);
  f.close();
  return true;
}

// =====================================================
// BUZZER (LEDC)
// =====================================================
static void buzzerInit() {
  ledcAttachPin(PIN_BUZZER, BUZZER_CH);
  ledcWriteTone(BUZZER_CH, 0);
}

static void toneMs(uint16_t freq, uint16_t ms) {
  ledcWriteTone(BUZZER_CH, freq);
  delay(ms);
  ledcWriteTone(BUZZER_CH, 0);
  delay(15);
}

static void playBuzzer(const String& tipo) {
  if (tipo == "correcto") {
    toneMs(2000, 120);
    toneMs(2500, 120);
  } else if (tipo == "incorrecto") {
    toneMs(400, 250);
  } else if (tipo == "aprobado") {
    toneMs(1500, 180);
    toneMs(1800, 180);
    toneMs(2100, 260);
  } else {
    toneMs(900, 120);
  }
}

// =====================================================
// BUTTONS (INPUT_PULLUP + debounce)
// =====================================================
struct Btn {
  uint8_t pin;
  const char* code;     // "A".."E","START","CANCEL","ACCEPT"
  bool stable;
  bool lastRead;
  uint32_t lastChangeMs;
};

static Btn btns[] = {
  { PIN_BTN_A_RED,    "A", true, true, 0 },
  { PIN_BTN_B_GREEN,  "B", true, true, 0 },
  { PIN_BTN_C_YELLOW, "C", true, true, 0 },
  { PIN_BTN_D_WHITE,  "D", true, true, 0 },
  { PIN_BTN_E_BLUE,   "E", true, true, 0 },

  { PIN_BTN_START,    "START",  true, true, 0 },
  { PIN_BTN_CANCEL,   "CANCEL", true, true, 0 },
  { PIN_BTN_ACCEPT,   "ACCEPT", true, true, 0 },
};

static void buttonsInit() {
  for (auto &b : btns) {
    pinMode(b.pin, INPUT_PULLUP);
    b.stable = digitalRead(b.pin);
    b.lastRead = b.stable;
    b.lastChangeMs = millis();
  }
}

static void onButtonPressed(const String& code) {
  if (code == "START" || code == "CANCEL") {
    pushEvent(code);
    return;
  }

  // Letras A–E
  if (code.length() == 1 && code[0] >= 'A' && code[0] <= 'E') {
    g_lastSelectedLetter = code;
    g_lastSelectedMs = millis();
    pushEvent(code);
    return;
  }

  // ACCEPT: confirma re-emitiendo última letra dentro de ventana
  if (code == "ACCEPT") {
    if (g_lastSelectedLetter.length() == 1 &&
        (millis() - g_lastSelectedMs) <= ACCEPT_WINDOW_MS) {
      pushEvent(g_lastSelectedLetter);
    }
    return;
  }
}

static void pollButtons() {
  const uint32_t now = millis();
  for (auto &b : btns) {
    bool r = digitalRead(b.pin);

    if (r != b.lastRead) {
      b.lastRead = r;
      b.lastChangeMs = now;
    }

    if ((now - b.lastChangeMs) > DEBOUNCE_MS && r != b.stable) {
      b.stable = r;

      // flanco de presión: HIGH -> LOW
      if (b.stable == LOW) {
        onButtonPressed(String(b.code));
      }
    }
  }
}

// =====================================================
// API
// =====================================================
static void apiStateGet() {
  sendNoCache();
  server.send(200, "application/json; charset=utf-8", g_stateJson);
}

static void apiStatePost() {
  if (!server.hasArg("plain")) {
    server.send(400, "application/json; charset=utf-8", "{\"ok\":false,\"error\":\"missing body\"}");
    return;
  }
  const String body = server.arg("plain");

  // ArduinoJson v6: usar DynamicJsonDocument / StaticJsonDocument
  DynamicJsonDocument doc(4096);
  DeserializationError err = deserializeJson(doc, body);
  if (err) {
    server.send(400, "application/json; charset=utf-8", "{\"ok\":false,\"error\":\"invalid json\"}");
    return;
  }

  g_stateJson = body;
  const bool ok = saveState(body);
  server.send(200, "application/json; charset=utf-8", ok ? "{\"ok\":true}" : "{\"ok\":false}");
}

static void apiLastButton() {
  StaticJsonDocument<128> doc;
  doc["eventId"] = g_eventId;
  doc["button"]  = g_lastButton;

  String out;
  serializeJson(doc, out);

  sendNoCache();
  server.send(200, "application/json; charset=utf-8", out);
}

static void apiBuzzer() {
  String tipo = "";

  if (server.hasArg("plain")) {
    DynamicJsonDocument doc(256);
    if (!deserializeJson(doc, server.arg("plain"))) {
      tipo = (const char*)(doc["tipo"] | "");
    }
  }
  if (tipo.length() == 0 && server.hasArg("tipo")) {
    tipo = server.arg("tipo");
  }

  playBuzzer(tipo);
  server.send(200, "application/json; charset=utf-8", "{\"ok\":true}");
}

// =====================================================
// WiFiManager + mDNS
// =====================================================
static void setupWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(MDNS_NAME);

  WiFiManager wm;
  wm.setDebugOutput(true);

  const String apSsid = buildApSsid();   // ARCADE-QUIZxxxx
  // AP sin password
  bool ok = wm.autoConnect(apSsid.c_str());
  if (!ok) {
    Serial.println("[WiFi] autoConnect falló o quedó en portal/AP.");
  } else {
    Serial.print("[WiFi] Conectado. IP: ");
    Serial.println(WiFi.localIP());
  }
}

// =====================================================
// SETUP / LOOP
// =====================================================
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n=== ARCADE QUIZ ESP32 (WiFiManager + mDNS + LittleFS) ===");

  if (!LittleFS.begin(true)) {
    Serial.println("[FS] LittleFS mount FAILED");
  } else {
    Serial.println("[FS] LittleFS OK");
  }

  loadState();
  buttonsInit();
  buzzerInit();

  setupWiFi();

  if (MDNS.begin(MDNS_NAME)) {
    Serial.printf("[mDNS] OK: http://%s.local/\n", MDNS_NAME);
  } else {
    Serial.println("[mDNS] FAILED");
  }

  // API
  server.on("/api/state", HTTP_GET,  apiStateGet);
  server.on("/api/state", HTTP_POST, apiStatePost);
  server.on("/api/last_button", HTTP_GET, apiLastButton);
  server.on("/api/buzzer", HTTP_POST, apiBuzzer);

  // Web
  server.on("/", HTTP_GET, []() {
    if (!serveFile("/index.html")) {
      server.send(500, "text/plain; charset=utf-8",
                  "Falta /index.html en LittleFS. Copia tus archivos a /data y ejecuta: pio run -t uploadfs");
    }
  });

  server.onNotFound([]() {
    if (serveFile(server.uri())) return;
    server.send(404, "text/plain; charset=utf-8", "404 Not Found");
  });

  server.begin();
  Serial.println("[HTTP] Server started :80");
}

void loop() {
  server.handleClient();
  pollButtons();
}
