import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";

function App() {
  return (
    <main className="shell">
      <p className="eyebrow">HookForge</p>
      <h1>Webhook delivery infrastructure.</h1>
      <p className="lede">
        The dashboard foundation is ready. Project, endpoint, event, and
        delivery views will be connected to the API in later milestones.
      </p>
      <div className="status-card">
        <span className="status-dot" aria-hidden="true" />
        <div>
          <strong>Foundation milestone</strong>
          <p>
            API health, dependency readiness, and local infrastructure are
            configured.
          </p>
        </div>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
