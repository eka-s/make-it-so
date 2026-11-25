import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/antonio/400.css";
import "@fontsource/antonio/700.css";
import "./theme.css";
import { App } from "./App";
import { I18nProvider } from "./i18n/I18nProvider";
import "./theme-light-dark.css";
import "./desktop-shell.css";
import { watchLayoutMode } from "./layout-mode";
import { markShell } from "./shell";

markShell();
watchLayoutMode();

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Root element not found");

createRoot(rootElement).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>
);
