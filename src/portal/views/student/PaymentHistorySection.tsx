import type { VM } from "../../vm/types";

export default function PaymentHistorySection({ v }: { v: VM }) {
  const rows = v.paymentHistory ?? [];
  return (
    <section id="portal-payments" style={{ gridColumn: "1/-1", background: "#fff", border: "1px solid rgba(17,22,27,.1)", borderRadius: "2px", boxShadow: "0 1px 2px rgba(17,22,27,.04)", padding: "28px" }}>
      <span style={{ fontSize: "11px", letterSpacing: ".25em", textTransform: "uppercase", fontWeight: "600", color: "#9C5F22" }}>Billing</span>
      <h2 style={{ fontFamily: "'Cinzel',Georgia,serif", fontWeight: "500", fontSize: "20px", letterSpacing: ".06em", textTransform: "uppercase", color: "#1D2A44", margin: "6px 0 8px" }}>Payment history</h2>
      <p style={{ margin: "0 0 16px", fontSize: "13px", color: "rgba(17,22,27,.55)", lineHeight: 1.5 }}>Recorded by your teacher. Nothing is charged from this page.</p>
      {v.paymentUnavailable && <div style={{ fontSize: "14px", color: "rgba(17,22,27,.65)" }}>Payment history can't be shown right now. Please check back shortly.</div>}
      {!v.paymentUnavailable && rows.length === 0 && <div style={{ fontSize: "14px", color: "rgba(17,22,27,.65)" }}>No payments yet.</div>}
      {rows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px", minWidth: "480px" }}>
            <thead>
              <tr style={{ textAlign: "left", fontSize: "11px", letterSpacing: ".16em", textTransform: "uppercase", color: "rgba(17,22,27,.5)" }}>
                <th style={{ padding: "8px 0", fontWeight: 600 }}>Invoice</th>
                <th style={{ padding: "8px 0", fontWeight: 600 }}>Date</th>
                <th style={{ padding: "8px 0", fontWeight: 600 }}>Paid</th>
                <th style={{ padding: "8px 0", fontWeight: 600 }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row: { id: string; number: string; date: string; amount: string; status: string }) => (
                <tr key={row.id}>
                  <td style={{ padding: "10px 12px 10px 0", borderTop: "1px solid rgba(17,22,27,.06)" }}>#{row.number}</td>
                  <td style={{ padding: "10px 12px 10px 0", borderTop: "1px solid rgba(17,22,27,.06)" }}>{row.date}</td>
                  <td style={{ padding: "10px 12px 10px 0", borderTop: "1px solid rgba(17,22,27,.06)" }}>{row.amount}</td>
                  <td style={{ padding: "10px 0", borderTop: "1px solid rgba(17,22,27,.06)", color: "#4A6149" }}>{row.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
