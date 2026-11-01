import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@phosphor-icons/web/regular";
import "@phosphor-icons/web/fill";
import "./portal.css";
import PortalApp from "./PortalApp";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <PortalApp />
    </BrowserRouter>
  </StrictMode>,
);
