import type { VM } from "../../vm/types";

export default function Toast({ v }: { v: VM }) {
  return (
    <><div role="status" aria-live="polite" style={{ position: "fixed", left: "50%", bottom: "28px", transform: "translateX(-50%)", zIndex: "400", background: "#1D2A44", color: "#fff", padding: "12px 18px", borderRadius: "2px", boxShadow: "0 10px 30px rgba(17,22,27,.3)", fontSize: "13px", display: "flex", alignItems: "center", gap: "10px", maxWidth: "calc(100vw - 40px)" }}><i className="ph-fill ph-check-circle" style={{ color: "#E0A363", fontSize: "18px" }}></i>{v.toast}</div></>
  );
}
