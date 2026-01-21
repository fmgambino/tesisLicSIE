<p align="center">
  <img src="https://frt.utn.edu.ar/wp-content/uploads/elementor/thumbs/descarga-removebg-preview-qxah6c0ycvhe6sie8wx30a0gb3rf1yn226favl26tc-qy17u6no60q8xbkeh0dtetqyiz7hei7hiu2sc1k9vk.png" width="300">
</p>

# 🎓 Proyecto: Recurso Educativo Interactivo Aplicando Sistemas de Inteligencia Embebida

---

## 📌 Descripción General

Este proyecto consiste en el desarrollo de un **Recurso Educativo Interactivo** basado en **sistemas de inteligencia embebida**, orientado a mejorar los procesos de enseñanza-aprendizaje mediante la integración de:

- Electrónica e IoT  
- Sistemas embebidos (ESP32)  
- Interacción físico-digital  
- Gamificación educativa  
- Interfaces web locales  
- Automatización y control  

El sistema permite implementar dinámicas de **quiz interactivo**, evaluaciones en tiempo real y experiencias lúdicas educativas, integrando botones físicos, señales acústicas (buzzer) y una plataforma web local accesible desde cualquier dispositivo.

Está diseñado como **herramienta pedagógica**, adaptable a contextos STEAM, robótica educativa, informática, electrónica y formación técnica.

---

## 🧠 Objetivo del Proyecto

Desarrollar un sistema educativo innovador que:

- Promueva el **aprendizaje activo**
- Incorpore **inteligencia embebida** como recurso didáctico
- Integre **hardware + software + pedagogía**
- Potencie la motivación, la participación y la evaluación interactiva

---

## 🏗️ Arquitectura del Sistema

- **Controlador principal:** ESP32 DevKit V1  
- **Interfaz física:**  
  - Botones de respuesta (A-E)  
  - Botón Start  
  - Botón Aceptar  
  - Botón Cancelar  
  - Buzzer acústico  

- **Interfaz digital:**  
  - Servidor web local embebido  
  - Panel interactivo HTML/CSS/JS  
  - Sistema de preguntas, temporizador y resultados  

- **Conectividad:**  
  - WiFiManager (configuración dinámica)  
  - mDNS → `http://arcadequiz.local`  

- **Almacenamiento:**  
  - LittleFS (configuración, preguntas y resultados)

---

## 🧩 Tecnologías Utilizadas

### 🔧 Hardware
- ESP32 DevKit V1  
- Pulsadores físicos  
- Buzzer pasivo  
- Fuente 5V  
- Cableado y estructura física

### 💻 Software
- PlatformIO + Arduino Framework  
- WiFiManager  
- WebServer ESP32  
- ArduinoJson  
- LittleFS  
- HTML5 + CSS3 + JavaScript  
- SweetAlert2  
- XLSX.js  

---

## 🖥️ Funcionalidades

- ✅ Quiz interactivo en red local  
- ✅ Acceso desde celulares, tablets y PC  
- ✅ Sistema de preguntas editable  
- ✅ Control físico por botones  
- ✅ Señales acústicas de validación  
- ✅ Almacenamiento persistente  
- ✅ Modo docente / administración  
- ✅ Interfaz amigable  
- ✅ Gamificación educativa  

---

## 🖼️ Galería del Proyecto

*(Reemplazar los links cuando tengas las fotos finales)*

- 📷 Foto general del sistema  
👉 https://LINK_DE_TU_FOTO_1

- 📷 Vista del hardware  
👉 https://LINK_DE_TU_FOTO_2

- 📷 Interfaz web en funcionamiento  
👉 https://LINK_DE_TU_FOTO_3

- 📷 Uso en aula / pruebas  
👉 https://LINK_DE_TU_FOTO_4

---

## 📂 Estructura del Repositorio

## 🚀 Puesta en Marcha

1. Clonar el repositorio  
2. Abrir con PlatformIO  
3. Cargar archivos web al ESP32:

```bash
pio run -t uploadfs

