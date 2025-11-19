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
 *
 * Esto hace que, aunque en el TXT la respuesta correcta sea siempre B,
 * en pantalla pueda quedar en A, C, D o E (de forma aleatoria).
 */
function shuffleQuestionOptions(question) {
  const originalLetters = ["A", "B", "C", "D", "E"];
  const shuffledLetters = originalLetters.slice();

  // Shuffle de las letras originales
  for (let i = shuffledLetters.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffledLetters[i], shuffledLetters[j]] = [shuffledLetters[j], shuffledLetters[i]];
  }

  const newOptions = {};
  let newCorrect = "A";

  // Vamos a asignar las opciones a A,B,C,D,E PERO en orden mezclado
  // Ej: A <- opción que antes era C, B <- opción que antes era A, etc.
  for (let idx = 0; idx < originalLetters.length; idx++) {
    const newLetter = originalLetters[idx];      // A, B, C, D, E
    const oldLetter = shuffledLetters[idx];      // alguna permutación de A..E

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

  // Ahora mezclamos las opciones de cada pregunta para que la correcta se mueva de letra
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

/************* MANEJO DE OPCIONES (A–E) *************/
function handleOptionClick(optionLetter) {
  if (!quizInProgress) {
    Swal.fire("Atención", "Primero presiona Start para iniciar el evaluativo.", "info");
    return;
  }

  const q = questions[currentQuestionIndex];

  Swal.fire({
    title: "Confirmar respuesta",
    text: `¿Seguro que deseas marcar la opción ${optionLetter}?`,
    icon: "question",
    showCancelButton: true,
    confirmButtonText: "Confirmar",
    cancelButtonText: "Cancelar"
  }).then(result => {
    if (result.isConfirmed) {
      const isCorrect = optionLetter === q.correct;
      if (isCorrect) correctCount++;

      Swal.fire({
        title: isCorrect ? "Respuesta correcta" : "Respuesta incorrecta",
        text: isCorrect ? "Muy bien." : `La respuesta correcta era ${q.correct}.`,
        icon: isCorrect ? "success" : "error",
        confirmButtonText: "Continuar"
      }).then(() => {
        goToNextQuestion();
      });
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
    html: `
      <div style="text-align:left;font-size:0.9rem">
        <label>Nombre del docente:</label>
        <input id="docNombre" class="swal2-input" placeholder="Nombre" value="${teacherConfig.nombreDocente || ""}">

        <label>Apellido del docente:</label>
        <input id="docApellido" class="swal2-input" placeholder="Apellido" value="${teacherConfig.apellidoDocente || ""}">

        <label>Curso:</label>
        <input id="docCurso" class="swal2-input" placeholder="Ej: 3°" value="${teacherConfig.curso || ""}">

        <label>División:</label>
        <input id="docDivision" class="swal2-input" placeholder="Ej: A" value="${teacherConfig.division || ""}">

        <label>Cantidad de preguntas a mostrar:</label>
        <input id="numPreguntas" type="number" class="swal2-input" min="1" placeholder="Ej: 15" value="${numPlaceholder}">

        <label>Modo de cronómetro:</label>
        <div class="timer-mode-row" style="margin-bottom:0.5rem;">
          <label style="margin-right:0.5rem;">
            <input type="radio" name="timerMode" value="up" ${mode === "up" ? "checked" : ""}>
            Incremental (0 → ...)
          </label>
          <label>
            <input type="radio" name="timerMode" value="down" ${mode === "down" ? "checked" : ""}>
            Decremental (X min → 0)
          </label>
        </div>

        <label>Minutos para cronómetro decreciente:</label>
        <input id="timerMinutes" type="number" class="swal2-input" min="1" placeholder="Ej: 40" value="${minutesVal}">

        <label>Archivo TXT de preguntas:</label>
        <input id="questionsFile" type="file" class="swal2-file" accept=".txt">

        <div style="margin-top:0.4rem;font-size:0.8rem;">
          <strong>Formato por pregunta:</strong><br>
          ¿Pregunta?<br>
          A) ...<br>B) ...<br>C) ...<br>D) ...<br>E) ...<br>ANSWER: C
        </div>

        <button type="button" id="downloadExampleTxt" style="
          margin-top:0.6rem;
          padding:6px 10px;
          font-size:0.8rem;
          border-radius:999px;
          border:1px solid #ccc;
          background:#f5f5f5;
          cursor:pointer;
        ">
          Descargar ejemplo TXT (10 preguntas)
        </button>

        <div style="margin-top:0.8rem;font-size:0.8rem;">
          <strong>Usuario y contraseña de administrador (para próximos accesos):</strong>
          <input id="adminUser" class="swal2-input" placeholder="Usuario admin" value="${adminCreds.user}">
          <input id="adminPass" class="swal2-input" placeholder="Contraseña admin" type="password" value="${adminCreds.pass}">
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
      <input id="loginUser" class="swal2-input" placeholder="Usuario">
      <div class="password-wrapper">
        <input id="loginPass" class="swal2-input" placeholder="Contraseña" type="password">
        <button type="button" id="toggleLoginPass" class="eye-btn">👁️</button>
      </div>
    `,
    focusConfirm: false,
    showCancelButton: true,
    confirmButtonText: "Ingresar",
    cancelButtonText: "Cancelar",
    didOpen: () => {
      const passInput = document.getElementById("loginPass");
      const toggleBtn = document.getElementById("toggleLoginPass");
      if (passInput && toggleBtn) {
        toggleBtn.addEventListener("click", () => {
          if (passInput.type === "password") {
            passInput.type = "text";
            toggleBtn.textContent = "🙈";
          } else {
            passInput.type = "password";
            toggleBtn.textContent = "👁️";
          }
        });
      }
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

/************* INICIALIZACIÓN *************/
function initApp() {
  selectModeAtStartup();

  loadSavedTheme();
  loadAdminFromStorage();
  loadConfigFromStorage();
  loadResultsFromStorage();

  // En modo ESP32 o BOTH, intentamos cargar estado persistido del micro
  tryLoadStateFromEsp32().then(() => {
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
