import React from "react";
import { createRoot } from "react-dom/client";
import "./i18n";
import App from "./App";
import { registerServiceWorker } from "./pwa/registerSW";
import { isNewDocumentHash, prefetchDocumentEditor } from "./document/bookmark";

if (isNewDocumentHash(location.hash)) {
  document.title = "Éditeur Filenymous";
  prefetchDocumentEditor();
}

const root = document.getElementById("root")!;
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Register SW after first paint — does not block UI
void registerServiceWorker();
