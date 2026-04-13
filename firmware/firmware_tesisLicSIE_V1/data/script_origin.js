/************* CLAVES LOCALSTORAGE *************/
const CONFIG_KEY = "quizConfigV1";
const QUESTIONS_TXT_KEY = "quizQuestionsTxtV1";
const RESULTS_KEY = "quizResultsV1";
const ADMIN_KEY = "quizAdminCredsV1";
const MODE_KEY = "quizModeV1"; // esp32 | browser | both

/************* MODO DE OPERACIÓN *************/
// esp32  = solo con ESP32 (offline, AP, sin CDN confiable)
// browser = solo navegador (sin ESP32)
// both   = puede usarse con o sin ESP32, intentando integrarse con /api/state
let modoOperacion = "both";

/************* ESTADO GLOBAL *************/
let allQuestions = [];     // Todas las preguntas cargadas desde el TXT (formato "original")
let questions = [];        // Subconjunto aleatorio usado en el test actual (con opciones mezcladas)
let questionsTxt = "";     // Contenido crudo del TXT

let teacherConfig = {
  nombreDocente: "",
  apellidoDocente: "",
  curso: "",
  division: "",
  numQuestions: 0,
  timerMode: "up",      // "up" incremental | "down" decreciente
  timerMinutes: 40      // solo para modo "down"
};

let hasConfig = false;

// Credenciales admin (se pueden cambiar en configuración)
let adminCreds = {
  user: "admin",
  pass: "admin0381"
};

let currentStudent = null; // { nombre, apellido }
let attemptCount = 0;
const maxAttempts = 3;
const passingGrade = 6;

let currentQuestionIndex = 0;
let correctCount = 0;
let quizInProgress = false;

// Cronómetro
let timerMode = "up";       // "up" | "down"
let elapsedSeconds = 0;     // tiempo transcurrido
let remainingSeconds = 0;   // tiempo restante (modo down)
let timerInterval = null;

let results = []; // ranking de alumnos

// Para que el "próximo alumno" no reciba el mismo conjunto que el anterior
let lastQuestionSetSignature = null;

// Para la confirmación con doble pulsación de botón físico
let pendingConfirmOption = null;   // Letra pendiente de confirmar (A–E) si hay popup abierto
let lastButtonEventIdSeen = 0;     // Último eventId de /api/last_button procesado
let hardwarePollInterval = null;   // Intervalo de polling de botones físicos

/************* REFERENCIAS DOM *************/
const body = document.body;
const themeCheckbox = document.getElementById("themeCheckbox");
const btnStart = document.getElementById("btnStart");
const btnShowResults = document.getElementById("btnShowResults");
const btnEditConfig = document.getElementById("btnEditConfig");

/************* UTILIDADES GENERALES *************/
function formatTime(seconds) {
  const m = String(Math.floor(seconds / 60)).padStart(2, "0");
  const s = String(seconds % 60).padStart(2, "0");
  return `${m}:${s}`;
}

// Mapea nota (0–10) a 0–5 estrellas
function gradeToStars(grade) {
  if (grade >= 9) return "★★★★★";
  if (grade >= 8) return "★★★★";
  if (grade >= 7) return "★★★";
  if (grade >= 6) return "★★";
  if (grade >= 4) return "★";
  return "";
}

// Carga dinámica de scripts (para XLSX por CDN si hace falta)
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("No se pudo cargar " + src));
    document.head.appendChild(s);
  });
}


function getIconSvg(name) {
  const icons = {
    eye: `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M2.04 12a11.98 11.98 0 0 1 19.92 0A11.98 11.98 0 0 1 12 19.5 11.98 11.98 0 0 1 2.04 12Z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"></path>
        <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="1.9"></circle>
      </svg>
    `,
    eyeOff: `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M3 3l18 18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"></path>
        <path d="M10.58 10.58A3 3 0 0 0 13.42 13.42" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"></path>
        <path d="M9.88 5.09A10.94 10.94 0 0 1 12 4.88c5.05 0 8.93 3.35 10 7.12a11.8 11.8 0 0 1-4.17 5.94" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"></path>
        <path d="M6.61 6.61A11.83 11.83 0 0 0 2 12c1.07 3.77 4.95 7.12 10 7.12 1.76 0 3.39-.4 4.84-1.09" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"></path>
      </svg>
    `,
    upload: `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M12 16V4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"></path>
        <path d="M7.5 8.5 12 4l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"></path>
        <path d="M4 16.5V18a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"></path>
      </svg>
    `
  };
  return icons[name] || "";
}

function setupPasswordToggle(inputId, buttonId) {
  const passInput = document.getElementById(inputId);
  const toggleBtn = document.getElementById(buttonId);
  if (!passInput || !toggleBtn) return;

  const syncState = () => {
    const isPassword = passInput.type === "password";
    toggleBtn.innerHTML = `<span class="eye-icon">${getIconSvg(isPassword ? "eye" : "eyeOff")}</span>`;
    toggleBtn.setAttribute("aria-label", isPassword ? "Mostrar contraseña" : "Ocultar contraseña");
    toggleBtn.setAttribute("title", isPassword ? "Mostrar contraseña" : "Ocultar contraseña");
  };

  toggleBtn.addEventListener("click", () => {
    passInput.type = passInput.type === "password" ? "text" : "password";
    syncState();
  });

  syncState();
}

/************* MODO DE TRABAJO (ESP32 / BROWSER / BOTH) *************/
function selectModeAtStartup() {
  const saved = localStorage.getItem(MODE_KEY);
  if (saved === "esp32" || saved === "browser" || saved === "both") {
    modoOperacion = saved;
    return;
  }

  const resp = window.prompt(
    "Seleccionar modo de trabajo:\n" +
      "1 - Solo ESP32 (offline, accediendo por AP del ESP32)\n" +
      "2 - Solo Navegador (sin ESP32)\n" +
      "3 - Ambos (usar con o sin ESP32)\n\n" +
      "Ingresa 1, 2 o 3:",
    "3"
  );

  if (resp === "1") {
    modoOperacion = "esp32";
  } else if (resp === "2") {
    modoOperacion = "browser";
  } else {
    modoOperacion = "both";
  }

  localStorage.setItem(MODE_KEY, modoOperacion);
}

/************* CARGA DINÁMICA XLSX (para exportar Excel) *************/
function ensureXlsxLoaded() {
  // Si ya está cargado (desde archivo local en ESP32 / hosting / CDN), listo
  if (typeof XLSX !== "undefined") return Promise.resolve();

  // Modo solo ESP32: NO intentamos CDN, porque asumimos que no hay internet
  if (modoOperacion === "esp32") {
    return Promise.reject(
      new Error(
        "Modo ESP32: XLSX debe estar disponible como archivo local (xlsx.full.min.js)."
      )
    );
  }

  // Modo navegador o ambos: intentamos CDN si falta la librería local
  return loadScript(
    "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"
  ).then(() => {
    if (typeof XLSX === "undefined") {
      throw new Error("XLSX sigue sin estar disponible tras intentar CDN");
    }
  });
}

/************* CRONÓMETRO *************/
function updateTimerDisplay() {
  const timerEl = document.getElementById("timer");
  const progressEl = document.getElementById("progress-text");
  if (!timerEl || !progressEl) return;

  if (timerMode === "down") {
    const secs = Math.max(remainingSeconds, 0);
    const timeStr = formatTime(secs);
    timerEl.textContent = timeStr;
    if (questions && questions.length > 0) {
      progressEl.textContent =
        `Tiempo restante: ${timeStr} | Pregunta ${currentQuestionIndex + 1} de ${questions.length}`;
    } else {
      progressEl.textContent = `Tiempo restante: ${timeStr}`;
    }
  } else {
    const timeStr = formatTime(elapsedSeconds);
    timerEl.textContent = timeStr;
    if (questions && questions.length > 0) {
      progressEl.textContent =
        `Tiempo transcurrido: ${timeStr} | Pregunta ${currentQuestionIndex + 1} de ${questions.length}`;
    } else {
      progressEl.textContent = `Tiempo transcurrido: ${timeStr}`;
    }
  }
}

function startTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  elapsedSeconds = 0;

  if (teacherConfig.timerMode === "down") {
    timerMode = "down";
    let mins = parseInt(teacherConfig.timerMinutes, 10);
    if (isNaN(mins) || mins < 1) mins = 40;
    remainingSeconds = mins * 60;
    updateTimerDisplay();

    timerInterval = setInterval(() => {
      elapsedSeconds++;
      remainingSeconds--;
      updateTimerDisplay();

      if (remainingSeconds <= 0) {
        remainingSeconds = 0;
        clearInterval(timerInterval);
        timerInterval = null;
        if (quizInProgress) {
          Swal.fire({
            title: "Tiempo agotado",
            text: "El tiempo asignado para el test ha finalizado. Se corregirá automáticamente con las respuestas dadas.",
            icon: "warning",
            confirmButtonText: "Ver resultado"
          }).then(() => {
            finishQuiz(true);
          });
        }
      }
    }, 1000);
  } else {
    timerMode = "up";
    remainingSeconds = 0;
    updateTimerDisplay();

    timerInterval = setInterval(() => {
      elapsedSeconds++;
      updateTimerDisplay();
    }, 1000);
  }
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
}

/************* PARSEO DE TXT DE PREGUNTAS *************/
function parseQuestionsFromTxt(content) {
  const blocks = content.split(/\n\s*\n/);
  const parsed = [];

  blocks.forEach(block => {
    const lines = block
      .split("\n")
      .map(l => l.trim())
      .filter(l => l.length > 0);
    if (lines.length < 7) return;

    const questionText = lines[0];

    const options = {};
    ["A", "B", "C", "D", "E"].forEach(letter => {
      const line = lines.find(l => l.toUpperCase().startsWith(letter + ")"));
      if (line) {
        options[letter] = line
          .substring(2)
          .trim()
          .replace(/^[-.:]\s*/, "");
      }
    });

    let correct = "A";
    const answerLine = lines.find(l => l.toUpperCase().startsWith("ANSWER"));
    if (answerLine) {
      const upper = answerLine.toUpperCase();
      const match = upper.match(/ANSWER\s*:\s*([A-E])/);
      if (match) {
        correct = match[1];
      }
    }

    if (
      questionText &&
      options.A &&
      options.B &&
      options.C &&
      options.D &&
      options.E
    ) {
      parsed.push({ text: questionText, options, correct });
    }
  });

  return parsed;
}

/************* TXT EJEMPLO (10 PREGUNTAS) *************/
const EXAMPLE_TXT_10 = `1. ¿Qué es una necesidad económica?
A) Un deseo sin importancia
B) Algo totalmente prescindible
C) Una carencia que requiere bienes o servicios para ser satisfecha
D) Un lujo
E) Un capricho pasajero
ANSWER: C

2. ¿Cuál de los siguientes es un bien económico?
A) Aire
B) Luz solar
C) Agua potable distribuida
D) Viento
E) Lluvia
ANSWER: C

3. ¿Qué es un servicio?
A) Un objeto físico
B) Un bien natural
C) Una actividad que satisface necesidades
D) Un bien libre
E) Un impuesto
ANSWER: C

4. ¿Cuál es un factor productivo?
A) Consumo
B) Publicidad
C) Tierra, trabajo y capital
D) Impuestos
E) Ahorro
ANSWER: C

5. ¿Qué es salario?
A) Pago recibido por el trabajo
B) Costo de producción
C) Impuesto estatal
D) Ganancia empresaria
E) Crédito bancario
ANSWER: A

6. ¿Qué es ahorro?
A) Gastar todo el ingreso
B) Guardar parte del ingreso para el futuro
C) Pagar impuestos
D) Pedir préstamos
E) Comprar bienes de lujo
ANSWER: B

7. ¿Qué es inversión?
A) Destinar recursos para producir más en el futuro
B) Consumir hoy todo el ingreso
C) Pagar impuestos
D) Ahorrar en efectivo sin producir
E) Reducir la producción
ANSWER: A

8. ¿Qué es inflación?
A) Disminución general de precios
B) Aumento generalizado y sostenido de precios
C) Aumento del salario real
D) Aumento de exportaciones
E) Estabilidad de precios
ANSWER: B

9. ¿Qué es oferta?
A) Cantidad que los consumidores desean comprar
B) Cantidad que los productores están dispuestos a vender
C) Precio máximo fijado por ley
D) Cantidad de dinero en la economía
E) Gasto público
ANSWER: B

10. ¿Qué es demanda?
A) Cantidad que se desea vender
B) Cantidad que los consumidores desean adquirir
C) Cantidad producida por el Estado
D) Cantidad de exportaciones
E) Precio de equilibrio
ANSWER: B
`;

function downloadExampleTxt() {
  const blob = new Blob([EXAMPLE_TXT_10], {
    type: "text/plain;charset=utf-8;"
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "ejemplo_preguntas_10.txt";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/************* PERSISTENCIA LOCAL (localStorage) *************/
function saveConfigToStorage() {
  const cfg = {
    teacherConfig,
    numQuestions: teacherConfig.numQuestions
  };
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  localStorage.setItem(QUESTIONS_TXT_KEY, questionsTxt || "");
  persistStateToEsp32();
}

function loadConfigFromStorage() {
  try {
    const cfgRaw = localStorage.getItem(CONFIG_KEY);
    const txtRaw = localStorage.getItem(QUESTIONS_TXT_KEY);

    if (cfgRaw) {
      const cfg = JSON.parse(cfgRaw);
      if (cfg.teacherConfig) {
        teacherConfig = cfg.teacherConfig;
      } else if (cfg.numQuestions) {
        teacherConfig.numQuestions = cfg.numQuestions;
      }
      if (!teacherConfig.timerMode) teacherConfig.timerMode = "up";
      if (!teacherConfig.timerMinutes) teacherConfig.timerMinutes = 40;
    }

    if (txtRaw && txtRaw.trim().length > 0) {
      questionsTxt = txtRaw;
      allQuestions = parseQuestionsFromTxt(questionsTxt);
      if (allQuestions.length > 0) {
        if (!teacherConfig.numQuestions) {
          teacherConfig.numQuestions = allQuestions.length;
        }
        hasConfig = true;
      }
    }
  } catch (e) {
    console.error("Error cargando configuración:", e);
  }
}

function saveResultsToStorage() {
  localStorage.setItem(RESULTS_KEY, JSON.stringify(results));
  persistStateToEsp32();
}

function loadResultsFromStorage() {
  try {
    const raw = localStorage.getItem(RESULTS_KEY);
    if (raw) {
      results = JSON.parse(raw);
    }
  } catch (e) {
    console.error("Error cargando resultados:", e);
  }
}

function loadAdminFromStorage() {
  try {
    const raw = localStorage.getItem(ADMIN_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj.user && obj.pass) {
        adminCreds = obj;
      }
    }
  } catch (e) {
    console.error("Error cargando admin:", e);
  }
}

function saveAdminToStorage() {
  localStorage.setItem(ADMIN_KEY, JSON.stringify(adminCreds));
  persistStateToEsp32();
}

/************* PERSISTENCIA EN ESP32 (SPIFFS) VIA /api/state *************/
async function tryLoadStateFromEsp32() {
  if (modoOperacion === "browser") return;

  try {
    const res = await fetch("/api/state", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    if (!data || typeof data !== "object") return;

    if (data.adminCreds) {
      adminCreds = data.adminCreds;
      localStorage.setItem(ADMIN_KEY, JSON.stringify(adminCreds));
    }

    if (data.teacherConfig) {
      teacherConfig = data.teacherConfig;
      if (!teacherConfig.timerMode) teacherConfig.timerMode = "up";
      if (!teacherConfig.timerMinutes) teacherConfig.timerMinutes = 40;
      localStorage.setItem(
        CONFIG_KEY,
        JSON.stringify({ teacherConfig, numQuestions: teacherConfig.numQuestions })
      );
    }

    if (data.questionsTxt) {
      questionsTxt = data.questionsTxt;
      localStorage.setItem(QUESTIONS_TXT_KEY, questionsTxt);
      allQuestions = parseQuestionsFromTxt(questionsTxt);
    }

    if (Array.isArray(data.results)) {
      results = data.results;
      localStorage.setItem(RESULTS_KEY, JSON.stringify(results));
    }

    if (allQuestions.length > 0) {
      if (!teacherConfig.numQuestions) {
        teacherConfig.numQuestions = allQuestions.length;
      }
      hasConfig = true;
    }
  } catch (err) {
    console.warn("No se pudo leer /api/state (quizá no hay ESP32):", err.message);
  }
}

function persistStateToEsp32() {
  if (modoOperacion === "browser") return;

  const payload = {
    teacherConfig,
    questionsTxt,
    results,
    adminCreds
  };

  fetch("/api/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }).catch(err => {
    console.warn("No se pudo guardar /api/state:", err.message);
  });
}

/************* RANDOM: SHUFFLE + SUBSET *************/
function getRandomSubset(array, size) {
  const arr = array.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, size);
}

/**
 * Mezcla las opciones de una pregunta.
 *
 * - Recibe una pregunta "original": { text, options: {A..E}, correct: 'A'..'E' }
 * - Devuelve una pregunta nueva, con el mismo texto pero opciones reordenadas,
 *   y la letra de correct actualizada.
 */
function shuffleQuestionOptions(question) {
  const originalLetters = ["A", "B", "C", "D", "E"];
  const shuffledLetters = originalLetters.slice();

  // Mezclamos el orden de las letras originales
  for (let i = shuffledLetters.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffledLetters[i], shuffledLetters[j]] = [shuffledLetters[j], shuffledLetters[i]];
  }

  const newOptions = {};
  let newCorrect = "A";

  for (let idx = 0; idx < originalLetters.length; idx++) {
    const newLetter = originalLetters[idx];   // A, B, C, D, E
    const oldLetter = shuffledLetters[idx];   // permutación de A..E

    newOptions[newLetter] = question.options[oldLetter];

    if (oldLetter === question.correct) {
      newCorrect = newLetter;
    }
  }

  return {
    text: question.text,
    options: newOptions,
    correct: newCorrect
  };
}

/************* SUBCONJUNTO DE PREGUNTAS (ALEATORIO Y NO IGUAL AL ANTERIOR) *************/
function buildQuestionSet() {
  if (!allQuestions || allQuestions.length === 0) {
    return [];
  }

  const total = allQuestions.length;
  let n = teacherConfig.numQuestions || total;
  if (n < 1) n = 1;
  if (n > total) n = total;
  teacherConfig.numQuestions = n;

  let subset = [];
  let signature = "";
  let tries = 0;

  // Evita que el PRÓXIMO alumno reciba exactamente el mismo conjunto de preguntas
  do {
    subset = getRandomSubset(allQuestions, n);
    signature = subset.map(q => q.text).join("||");
    tries++;
  } while (signature === lastQuestionSetSignature && tries < 10);

  lastQuestionSetSignature = signature;

  // Mezclamos las opciones de cada pregunta para que la correcta se mueva de letra
  const shuffledQuestionSet = subset.map(q => shuffleQuestionOptions(q));
  return shuffledQuestionSet;
}

/************* CARGA DE PREGUNTA *************/
function loadQuestion() {
  if (!questions || questions.length === 0) {
    document.getElementById("question-number").textContent = "";
    document.getElementById("question-text").textContent =
      "No hay preguntas cargadas. El docente debe configurar el test.";
    ["A", "B", "C", "D", "E"].forEach(letter => {
      const el = document.getElementById("text-" + letter);
      if (el) el.textContent = "";
    });
    return;
  }

  const q = questions[currentQuestionIndex];
  document.getElementById("question-number").textContent =
    `Pregunta ${currentQuestionIndex + 1} de ${questions.length}`;
  document.getElementById("question-text").textContent = q.text;

  document.getElementById("text-A").textContent = q.options.A;
  document.getElementById("text-B").textContent = q.options.B;
  document.getElementById("text-C").textContent = q.options.C;
  document.getElementById("text-D").textContent = q.options.D;
  document.getElementById("text-E").textContent = q.options.E;
}

/************* BUZZER (ESP32) *************/
function playBuzzer(tipo) {
  // Solo tiene sentido si hay ESP32 / API disponible
  if (modoOperacion === "browser") return;

  fetch("/api/buzzer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tipo })
  }).catch((err) => {
    console.warn("No se pudo invocar /api/buzzer:", err.message);
  });
}

/************* MANEJO DE OPCIONES (A–E) *************/
/**
 * Lógica común para procesar la respuesta una vez confirmada
 * (ya sea por clic en "Confirmar" o segunda pulsación física).
 */
function confirmAnswer(optionLetter) {
  const q = questions[currentQuestionIndex];
  const isCorrect = optionLetter === q.correct;

  if (isCorrect) correctCount++;

  // Sonido de buzzer según correcto/incorrecto
  playBuzzer(isCorrect ? "correcto" : "incorrecto");

  Swal.fire({
    title: isCorrect ? "Respuesta correcta" : "Respuesta incorrecta",
    text: isCorrect ? "¡Muy bien!" : `La respuesta correcta era ${q.correct}.`,
    icon: isCorrect ? "success" : "error",
    confirmButtonText: "Continuar"
  }).then(() => {
    goToNextQuestion();
  });
}

/**
 * Maneja el clic en opción A–E en la interfaz (botones de la UI).
 * Para modo ESP32: al mostrarse el popup, se puede confirmar
 * con el mismo botón físico A–E por segunda vez (doble pulsación).
 */
function handleOptionClick(optionLetter) {
  if (!quizInProgress) {
    Swal.fire("Atención", "Primero presiona Start para iniciar el evaluativo.", "info");
    return;
  }

  const q = questions[currentQuestionIndex];
  if (!q) {
    Swal.fire("Error", "No se encontró la pregunta actual.", "error");
    return;
  }

  pendingConfirmOption = optionLetter;

  // Mensaje incluye instrucción para uso con ESP32
  const extraMsg =
    modoOperacion === "browser"
      ? ""
      : " (en modo ESP32, vuelve a presionar el mismo botón físico para confirmar).";

  Swal.fire({
    title: "Confirmar respuesta",
    text: `¿Seguro que deseas marcar la opción ${optionLetter}?${extraMsg}`,
    icon: "question",
    showCancelButton: true,
    confirmButtonText: "Confirmar",
    cancelButtonText: "Cancelar"
  }).then(result => {
    // Si pendingConfirmOption cambió por una pulsación física, no hacemos nada
    if (pendingConfirmOption !== null && pendingConfirmOption !== optionLetter) {
      return;
    }

    const wasPending = pendingConfirmOption === optionLetter;
    pendingConfirmOption = null;

    if (result.isConfirmed && wasPending) {
      confirmAnswer(optionLetter);
    }
  });
}
window.handleOptionClick = handleOptionClick;

function goToNextQuestion() {
  if (currentQuestionIndex < questions.length - 1) {
    currentQuestionIndex++;
    loadQuestion();
    updateTimerDisplay();
  } else {
    finishQuiz(false);
  }
}

/************* NOTA / FINALIZAR *************/
function calculateGrade() {
  if (!questions || questions.length === 0) return 0;
  return Math.round((correctCount / questions.length) * 10);
}

function finishQuiz(timeUp) {
  stopTimer();
  quizInProgress = false;

  const totalSeconds = elapsedSeconds;
  const grade = calculateGrade();
  const passed = grade >= passingGrade;
  const stars = gradeToStars(grade);

  // Sonido de "felicitaciones" si aprobó
  if (passed) {
    playBuzzer("aprobado");
  }

  if (currentStudent) {
    results.push({
      studentNombre: currentStudent.nombre,
      studentApellido: currentStudent.apellido,
      curso: teacherConfig.curso,
      division: teacherConfig.division,
      grade,
      totalSeconds,
      stars,
      teacher: { ...teacherConfig },
      timestamp: new Date().toISOString()
    });
    saveResultsToStorage();
  }

  const baseMsg =
    (currentStudent
      ? currentStudent.nombre + " " + currentStudent.apellido + ", "
      : "") +
    `tu nota es ${grade}/10.\n` +
    `Tiempo total: ${formatTime(totalSeconds)}.`;

  let title;
  let icon;

  if (timeUp) {
    title = passed ? "Tiempo agotado (aprobado)" : "Tiempo agotado";
    icon = "warning";
  } else {
    title = passed ? "Aprobado" : "Desaprobado";
    icon = passed ? "success" : "error";
  }

  Swal.fire({
    title,
    text: baseMsg,
    icon,
    confirmButtonText: "Continuar"
  }).then(() => {
    if (!passed && !timeUp && attemptCount < maxAttempts) {
      const remaining = maxAttempts - attemptCount;
      Swal.fire({
        title: "¿Reintentar el test?",
        text: `Te quedan ${remaining} intento(s).`,
        icon: "question",
        showCancelButton: true,
        confirmButtonText: "Rehacer",
        cancelButtonText: "Cancelar"
      }).then(r => {
        if (r.isConfirmed) {
          attemptCount++;
          beginQuizForCurrentStudent();
        }
      });
    }
  });
}

/************* REINICIAR CRONÓMETRO *************/
function resetCurrentTimer() {
  if (!quizInProgress) {
    Swal.fire("Información", "No hay un test en curso para reiniciar el cronómetro.", "info");
    return;
  }
  startTimer();
}
window.resetCurrentTimer = resetCurrentTimer;

/************* CONFIGURACIÓN DEL DOCENTE *************/

function openTeacherConfig(editMode) {
  const existingNum =
    teacherConfig.numQuestions || (allQuestions ? allQuestions.length : 0);
  const numPlaceholder = existingNum > 0 ? existingNum : "";
  const mode = teacherConfig.timerMode || "up";
  const minutesVal = teacherConfig.timerMinutes || 40;

  return Swal.fire({
    title: editMode ? "Editar configuración del evaluativo" : "Configurar evaluativo",
    width: 760,
    html: `
      <div class="form-layout form-layout-config">
        <div class="form-grid form-grid-config">
          <div class="form-field">
            <label class="form-label" for="docNombre">Nombre del docente</label>
            <input id="docNombre" class="swal2-input compact-input" placeholder="Nombre" value="${teacherConfig.nombreDocente || ""}">
          </div>

          <div class="form-field">
            <label class="form-label" for="docApellido">Apellido del docente</label>
            <input id="docApellido" class="swal2-input compact-input" placeholder="Apellido" value="${teacherConfig.apellidoDocente || ""}">
          </div>

          <div class="form-field">
            <label class="form-label" for="docCurso">Curso</label>
            <input id="docCurso" class="swal2-input compact-input" placeholder="Ej: 3°" value="${teacherConfig.curso || ""}">
          </div>

          <div class="form-field">
            <label class="form-label" for="docDivision">División</label>
            <input id="docDivision" class="swal2-input compact-input" placeholder="Ej: A" value="${teacherConfig.division || ""}">
          </div>

          <div class="form-field">
            <label class="form-label" for="numPreguntas">Cantidad de preguntas a mostrar</label>
            <input id="numPreguntas" type="number" class="swal2-input compact-input" min="1" placeholder="Ej: 15" value="${numPlaceholder}">
          </div>

          <div class="form-field">
            <label class="form-label">Modo de cronómetro</label>
            <div class="timer-mode-row">
              <label class="timer-mode-option">
                <input type="radio" name="timerMode" value="up" ${mode === "up" ? "checked" : ""}>
                <span>Incremental (0 → ...)</span>
              </label>
              <label class="timer-mode-option">
                <input type="radio" name="timerMode" value="down" ${mode === "down" ? "checked" : ""}>
                <span>Decremental (X min → 0)</span>
              </label>
            </div>
          </div>

          <div class="form-field">
            <label class="form-label" for="timerMinutes">Minutos para cronómetro decreciente</label>
            <input id="timerMinutes" type="number" class="swal2-input compact-input" min="1" placeholder="Ej: 40" value="${minutesVal}">
          </div>

          <div class="form-field form-field-full">
            <label class="form-label" for="questionsFile">Archivo TXT de preguntas</label>
            <input id="questionsFile" type="file" class="swal2-file compact-file" accept=".txt">
            <div class="form-helper">Puedes cargar un nuevo archivo o conservar el ya guardado.</div>
          </div>

          <div class="form-field form-field-full">
            <div class="form-example-block">
              <strong>Formato por pregunta:</strong><br>
              ¿Pregunta?<br>
              A) ...<br>B) ...<br>C) ...<br>D) ...<br>E) ...<br>ANSWER: C
            </div>
            <button type="button" id="downloadExampleTxt" class="popup-inline-btn">
              <span class="eye-icon">${getIconSvg("upload")}</span>
              <span>Descargar ejemplo TXT (10 preguntas)</span>
            </button>
          </div>

          <div class="form-field form-field-full admin-access-block">
            <label class="form-label" for="adminUser">Usuario administrador para próximos accesos</label>
            <div class="form-grid form-grid-admin">
              <div class="form-field">
                <label class="form-label form-label-sub" for="adminUser">Usuario</label>
                <input id="adminUser" class="swal2-input compact-input" placeholder="Usuario admin" value="${adminCreds.user}">
              </div>

              <div class="form-field">
                <label class="form-label form-label-sub" for="adminPass">Contraseña</label>
                <div class="password-wrapper compact-password-wrapper">
                  <input id="adminPass" class="swal2-input compact-input compact-password-input" placeholder="Contraseña admin" type="password" value="${adminCreds.pass}">
                  <button type="button" id="toggleAdminPass" class="eye-btn" aria-label="Mostrar contraseña"></button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `,
    focusConfirm: false,
    showCancelButton: true,
    confirmButtonText: "Guardar configuración",
    cancelButtonText: "Cancelar",
    didOpen: () => {
      const btn = document.getElementById("downloadExampleTxt");
      if (btn) {
        btn.addEventListener("click", downloadExampleTxt);
      }
      setupPasswordToggle("adminPass", "toggleAdminPass");
    },
    preConfirm: () => {
      const nombre = document.getElementById("docNombre").value.trim();
      const apellido = document.getElementById("docApellido").value.trim();
      const curso = document.getElementById("docCurso").value.trim();
      const division = document.getElementById("docDivision").value.trim();
      const numPreguntasStr = document
        .getElementById("numPreguntas")
        .value.trim();
      const file = document.getElementById("questionsFile").files[0];
      const timerMinutesStr = document
        .getElementById("timerMinutes")
        .value.trim();
      const modeSelected = document.querySelector(
        'input[name="timerMode"]:checked'
      );

      if (!nombre || !apellido || !curso || !division) {
        Swal.showValidationMessage("Completa todos los datos del docente.");
        return false;
      }

      if (
        !editMode &&
        !file &&
        (!questionsTxt || questionsTxt.trim().length === 0)
      ) {
        Swal.showValidationMessage(
          "El docente debe cargar un archivo TXT con las preguntas (o usar el ejemplo)."
        );
        return false;
      }

      let numPreg = parseInt(numPreguntasStr, 10);
      if (isNaN(numPreg) || numPreg < 1) {
        numPreg = 0;
      }

      let tMinutes = parseInt(timerMinutesStr, 10);
      if (isNaN(tMinutes) || tMinutes < 1) {
        tMinutes = 40;
      }

      let tMode = "up";
      if (modeSelected) {
        tMode = modeSelected.value === "down" ? "down" : "up";
      }

      return new Promise(resolve => {
        const updateAdminCreds = () => {
          const newAdminUser =
            document.getElementById("adminUser")?.value.trim();
          const newAdminPass = document.getElementById("adminPass")?.value;
          if (newAdminUser && newAdminPass) {
            adminCreds.user = newAdminUser;
            adminCreds.pass = newAdminPass;
            saveAdminToStorage();
          }
        };

        if (file) {
          const reader = new FileReader();
          reader.onload = () => {
            const content = reader.result;
            const parsed = parseQuestionsFromTxt(content);

            if (parsed.length === 0) {
              Swal.showValidationMessage(
                "No se pudieron leer preguntas válidas del TXT. Revisar formato."
              );
              resolve(false);
              return;
            }

            questionsTxt = content;
            allQuestions = parsed;

            if (!numPreg || numPreg > allQuestions.length) {
              numPreg = allQuestions.length;
            }

            teacherConfig = {
              nombreDocente: nombre,
              apellidoDocente: apellido,
              curso,
              division,
              numQuestions: numPreg,
              timerMode: tMode,
              timerMinutes: tMinutes
            };

            updateAdminCreds();
            saveConfigToStorage();
            resolve(true);
          };
          reader.onerror = () => {
            Swal.showValidationMessage("Error al leer el archivo TXT.");
            resolve(false);
          };
          reader.readAsText(file, "utf-8");
        } else {
          if (!allQuestions || allQuestions.length === 0) {
            Swal.showValidationMessage(
              "No hay preguntas cargadas. Debe cargar un TXT al menos una vez."
            );
            resolve(false);
            return;
          }

          if (!numPreg || numPreg > allQuestions.length) {
            numPreg = allQuestions.length;
          }

          teacherConfig = {
            nombreDocente: nombre,
            apellidoDocente: apellido,
            curso,
            division,
            numQuestions: numPreg,
            timerMode: tMode,
            timerMinutes: tMinutes
          };

          updateAdminCreds();
          saveConfigToStorage();
          resolve(true);
        }
      });
    }
  });
}

/************* LOGIN ADMIN PARA EDITAR CONFIG *************/


function promptAdminLoginAndEdit() {
  Swal.fire({
    title: "Acceso configuración",
    html: `
      <div class="form-layout form-layout-login">
        <div class="form-grid form-grid-single">
          <div class="form-field">
            <label class="form-label" for="loginUser">Usuario administrador</label>
            <input id="loginUser" class="swal2-input compact-input" placeholder="Usuario" autocomplete="username">
          </div>

          <div class="form-field">
            <label class="form-label" for="loginPass">Contraseña</label>
            <div class="password-wrapper compact-password-wrapper">
              <input id="loginPass" class="swal2-input compact-input compact-password-input" placeholder="Contraseña" type="password" autocomplete="current-password">
              <button type="button" id="toggleLoginPass" class="eye-btn" aria-label="Mostrar contraseña"></button>
            </div>
          </div>
        </div>
      </div>
    `,
    focusConfirm: false,
    showCancelButton: true,
    confirmButtonText: "Ingresar",
    cancelButtonText: "Cancelar",
    didOpen: () => {
      setupPasswordToggle("loginPass", "toggleLoginPass");
    },
    preConfirm: () => {
      const user = document.getElementById("loginUser").value.trim();
      const pass = document.getElementById("loginPass").value.trim();
      if (user !== adminCreds.user || pass !== adminCreds.pass) {
        Swal.showValidationMessage("Usuario o contraseña incorrectos.");
        return false;
      }
      return true;
    }
  }).then(res => {
    if (res.isConfirmed) {
      openTeacherConfig(true).then(ok => {
        if (ok && ok.value !== false) {
          hasConfig = allQuestions.length > 0;
          Swal.fire(
            "Configuración actualizada",
            "La configuración se guardó correctamente.",
            "success"
          );
        }
      });
    }
  });
}

/************* DATOS DEL ALUMNO *************/

function askStudentData() {
  return Swal.fire({
    title: "Datos del alumno",
    html: `
      <input id="alumNombre" class="swal2-input" placeholder="Nombre">
      <input id="alumApellido" class="swal2-input" placeholder="Apellido">
    `,
    focusConfirm: false,
    showCancelButton: true,
    confirmButtonText: "Comenzar test",
    cancelButtonText: "Cancelar",
    preConfirm: () => {
      const nombre = document.getElementById("alumNombre").value.trim();
      const apellido = document.getElementById("alumApellido").value.trim();

      if (!nombre || !apellido) {
        Swal.showValidationMessage("Completa nombre y apellido del alumno.");
        return false;
      }

      return { nombre, apellido };
    }
  });
}

/************* INICIO DEL QUIZ *************/
function beginQuizForCurrentStudent() {
  questions = buildQuestionSet();  // ALEATORIO (preguntas + orden de opciones)
  if (!questions || questions.length === 0) {
    Swal.fire("Error", "No hay preguntas cargadas. El docente debe configurar el test.", "error");
    return;
  }
  currentQuestionIndex = 0;
  correctCount = 0;
  quizInProgress = true;
  loadQuestion();
  startTimer();
}

function handleStartClick() {
  if (!hasConfig) {
    openTeacherConfig(false).then(ok => {
      if (ok && ok.value !== false) {
        hasConfig = allQuestions.length > 0;
        if (!hasConfig) return;
        askStudentData().then(res => {
          if (res.isConfirmed && res.value) {
            currentStudent = res.value;
            attemptCount = 1;
            beginQuizForCurrentStudent();
          }
        });
      }
    });
  } else {
    askStudentData().then(res => {
      if (res.isConfirmed && res.value) {
        currentStudent = res.value;
        attemptCount = 1;
        beginQuizForCurrentStudent();
      }
    });
  }
}

/************* RESULTADOS / RANKING *************/
function showResultsPopup() {
  if (results.length === 0) {
    Swal.fire("Resultados", "Todavía no hay resultados almacenados.", "info");
    return;
  }

  const sorted = [...results].sort((a, b) => {
    if (b.grade !== a.grade) return b.grade - a.grade;
    return a.totalSeconds - b.totalSeconds;
  });

  let rows = "";
  sorted.forEach(r => {
    rows += `
      <tr>
        <td>${r.studentApellido}, ${r.studentNombre}</td>
        <td>${r.curso}</td>
        <td>${r.division}</td>
        <td>${r.grade}</td>
        <td>${formatTime(r.totalSeconds)}</td>
        <td>${r.stars || ""}</td>
      </tr>
    `;
  });

  const html = `
    <div style="max-height:300px;overflow:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:0.85rem;">
        <thead>
          <tr>
            <th style="border-bottom:1px solid #ccc;padding:4px;text-align:left;">Alumno</th>
            <th style="border-bottom:1px solid #ccc;padding:4px;">Curso</th>
            <th style="border-bottom:1px solid #ccc;padding:4px;">División</th>
            <th style="border-bottom:1px solid #ccc;padding:4px;">Nota</th>
            <th style="border-bottom:1px solid #ccc;padding:4px;">Tiempo</th>
            <th style="border-bottom:1px solid #ccc;padding:4px;">Ranking (★)</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
    <div class="popup-actions">
      <button id="btnPopupExport" class="popup-btn" type="button">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 1v8.2L5.2 6.4 4.1 7.5 8 11.4l3.9-3.9-1.1-1.1L8 9.2V1zM2 13h12v2H2z"></path>
        </svg>
        <span>Descargar Excel</span>
      </button>
      <button id="btnPopupClear" class="popup-btn" type="button">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2 8l6-5 6 5v6H9V9H7v5H2z"></path>
        </svg>
        <span>Borrar resultados</span>
      </button>
    </div>
  `;

  Swal.fire({
    title: "Resultados de alumnos",
    html,
    width: 700,
    confirmButtonText: "Cerrar",
    didOpen: () => {
      const btnExport = document.getElementById("btnPopupExport");
      const btnClear = document.getElementById("btnPopupClear");

      if (btnExport) {
        btnExport.addEventListener("click", () => {
          exportResultsExcel();
        });
      }

      if (btnClear) {
        btnClear.addEventListener("click", () => {
          clearAllResults(true);
        });
      }
    }
  });
}

/************* EXPORTAR A EXCEL *************/
function exportResultsExcel() {
  if (results.length === 0) {
    Swal.fire("Exportar", "No hay resultados para exportar.", "info");
    return;
  }

  ensureXlsxLoaded()
    .then(() => {
      const header = [
        "DocenteNombre",
        "DocenteApellido",
        "CursoDocente",
        "DivisionDocente",
        "AlumnoNombre",
        "AlumnoApellido",
        "CursoAlumno",
        "DivisionAlumno",
        "Nota",
        "TiempoSegundos",
        "TiempoMMSS",
        "RankingEstrellas"
      ];

      const dataRows = results.map(r => [
        teacherConfig.nombreDocente,
        teacherConfig.apellidoDocente,
        teacherConfig.curso,
        teacherConfig.division,
        r.studentNombre,
        r.studentApellido,
        r.curso,
        r.division,
        r.grade,
        r.totalSeconds,
        formatTime(r.totalSeconds),
        r.stars || ""
      ]);

      const wb = XLSX.utils.book_new();
      const ws = {};

      const totalRows = 1 + dataRows.length;
      const totalCols = header.length;

      const range = {
        s: { c: 0, r: 0 },
        e: { c: totalCols - 1, r: totalRows - 1 }
      };
      ws["!ref"] = XLSX.utils.encode_range(range);

      ws["!cols"] = Array(totalCols).fill({ wch: 18 });

      const borderStyle = {
        top: { style: "thin", color: { rgb: "000000" } },
        bottom: { style: "thin", color: { rgb: "000000" } },
        left: { style: "thin", color: { rgb: "000000" } },
        right: { style: "thin", color: { rgb: "000000" } }
      };

      // Fila de encabezados
      header.forEach((h, c) => {
        const cellAddress = XLSX.utils.encode_cell({ c, r: 0 });
        ws[cellAddress] = {
          v: h,
          t: "s",
          s: {
            fill: { fgColor: { rgb: "4F81BD" } },   // azul
            font: { color: { rgb: "FFFFFF" }, bold: true },
            border: borderStyle,
            alignment: { horizontal: "center", vertical: "center" }
          }
        };
      });

      // Filas de datos
      dataRows.forEach((row, rIndex) => {
        const excelRow = rIndex + 1;
        const isEven = rIndex % 2 === 0;
        const bgColor = isEven ? "FFFFFF" : "DDEBF7";

        row.forEach((value, c) => {
          const cellAddress = XLSX.utils.encode_cell({ c, r: excelRow });
          ws[cellAddress] = {
            v: value,
            t: typeof value === "number" ? "n" : "s",
            s: {
              fill: { fgColor: { rgb: bgColor } },
              font: { color: { rgb: "000000" } },
              border: borderStyle,
              alignment: { horizontal: "center", vertical: "center" }
            }
          };
        });
      });

      XLSX.utils.book_append_sheet(wb, ws, "Resultados");
      const wbout = XLSX.write(wb, {
        bookType: "xlsx",
        type: "array"
      });

      const blob = new Blob([wbout], {
        type:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "resultados_evaluativo.xlsx";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    })
    .catch(err => {
      console.error(err);
      Swal.fire(
        "Error",
        "No se pudo acceder a la librería de Excel. Verifica el modo de trabajo y las librerías.",
        "error"
      );
    });
}

/************* BORRAR RESULTADOS *************/
function clearAllResults(fromPopup) {
  if (results.length === 0) {
    Swal.fire("Resultados", "No hay resultados para borrar.", "info");
    return;
  }

  Swal.fire({
    title: "Borrar resultados",
    text: "¿Seguro que deseas borrar TODOS los resultados almacenados?",
    icon: "warning",
    showCancelButton: true,
    confirmButtonText: "Sí, borrar",
    cancelButtonText: "Cancelar"
  }).then(res => {
    if (res.isConfirmed) {
      results = [];
      localStorage.removeItem(RESULTS_KEY);
      persistStateToEsp32();
      Swal.fire("Hecho", "Todos los resultados fueron borrados.", "success")
        .then(() => {
          if (fromPopup) {
            showResultsPopup();
          }
        });
    }
  });
}

/************* TEMA CLARO/OSCURO *************/
function applyTheme(theme) {
  body.setAttribute("data-theme", theme);
  if (themeCheckbox) {
    themeCheckbox.checked = theme === "dark";
  }
  localStorage.setItem("quiz-theme", theme);
}

function loadSavedTheme() {
  const saved = localStorage.getItem("quiz-theme");
  if (saved === "dark" || saved === "light") {
    applyTheme(saved);
  } else {
    applyTheme("light");
  }
}

/************* HARDWARE: LECTURA DE /api/last_button *************/
function handleHardwareButton(code) {
  if (!code) return;

  // START: solo inicia el evaluativo (si no está en curso)
  if (code === "START") {
    if (!quizInProgress) {
      handleStartClick();
    }
    return;
  }

  // RESET: reinicia cronómetro si hay quiz en curso
  if (code === "RESET") {
    resetCurrentTimer();
    return;
  }

  // CANCEL: si hay un popup de confirmación pendiente, lo cancela
  if (code === "CANCEL") {
    if (pendingConfirmOption !== null && Swal.isVisible()) {
      pendingConfirmOption = null;
      Swal.close();
    }
    return;
  }

  // A–E: opciones de respuesta
  const letters = ["A", "B", "C", "D", "E"];
  if (!letters.includes(code)) return;

  // Si ya hay una opción pendiente de confirmar y coincide con el código
  // => segunda pulsación (confirma la respuesta)
  if (pendingConfirmOption === code && Swal.isVisible()) {
    const optionLetter = pendingConfirmOption;
    pendingConfirmOption = null;
    Swal.close();              // Cerramos popup de confirmación
    confirmAnswer(optionLetter);
    return;
  }

  // Si NO hay pendiente (o es otra letra), tratamos como selección inicial
  handleOptionClick(code);
}

function startHardwarePolling() {
  if (modoOperacion === "browser") return; // Si solo navegador, no hay ESP32
  if (hardwarePollInterval) return;        // Ya está corriendo

  hardwarePollInterval = setInterval(async () => {
    try {
      const res = await fetch("/api/last_button", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (!data || typeof data !== "object") return;

      const eventId = typeof data.eventId === "number" ? data.eventId : 0;
      const button = data.button;

      if (!eventId || !button) return;
      if (eventId <= lastButtonEventIdSeen) return;

      lastButtonEventIdSeen = eventId;
      handleHardwareButton(button);
    } catch (err) {
      // Si no hay ESP32 o falla la API, solo registramos y seguimos
      // para no romper el flujo del navegador.
      // console.warn("Polling /api/last_button falló:", err.message);
    }
  }, 250); // Polling cada 250 ms
}

/************* INICIALIZACIÓN *************/
function initApp() {
  selectModeAtStartup();

  loadSavedTheme();
  loadAdminFromStorage();
  loadConfigFromStorage();
  loadResultsFromStorage();

  // En modo ESP32 o BOTH, intentamos cargar estado persistido del micro
  tryLoadStateFromEsp32().then(() => {
    // Arrancamos el polling de botones físicos si corresponde
    startHardwarePolling();

    if (themeCheckbox) {
      themeCheckbox.addEventListener("change", () => {
        const newTheme = themeCheckbox.checked ? "dark" : "light";
        applyTheme(newTheme);
      });
    }

    if (btnStart) btnStart.addEventListener("click", handleStartClick);
    if (btnShowResults) btnShowResults.addEventListener("click", showResultsPopup);
    if (btnEditConfig) btnEditConfig.addEventListener("click", promptAdminLoginAndEdit);

    const qNum = document.getElementById("question-number");
    const qText = document.getElementById("question-text");
    if (qNum && qText) {
      qNum.textContent = "";
      qText.textContent = "Presiona Start para comenzar el evaluativo.";
    }
    document.getElementById("timer").textContent = "00:00";
    document.getElementById("progress-text").textContent =
      "Esperando inicio del evaluativo…";
  });
}

window.addEventListener("load", initApp);
