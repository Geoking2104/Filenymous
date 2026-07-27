import React from "react";
import { createRoot } from "react-dom/client";
import "./i18n";
import App from "./App";
import { registerServiceWorker } from "./pwa/registerSW";

const root = document.getElementById("root")!;
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Register SW after first paint — does not block UI
void registerServiceWorker();
