import AddUrlDialog from "./AddUrlDialog";
import AutopayDialog from "./AutopayDialog";
import BookDialog from "./BookDialog";
import EditVideoDialog from "./EditVideoDialog";
import FamilyDialog from "./FamilyDialog";
import InvoiceDialog from "./InvoiceDialog";
import MigrateDialog from "./MigrateDialog";
import NoteDialog from "./NoteDialog";
import PackagesDialog from "./PackagesDialog";
import PayDialog from "./PayDialog";
import RecoveryDialog from "./RecoveryDialog";
import ScheduleDialog from "./ScheduleDialog";
import SecurityDialog from "./SecurityDialog";
import UploadVideoDialog from "./UploadVideoDialog";
import VideoDialog from "./VideoDialog";
import type { VM } from "../../vm/types";

export default function DialogHost({ v }: { v: VM }) {
  if (!v.dlg?.open) return null;
  return (
    <><div onClick={v.closeDialog} style={{ position: "fixed", inset: "0", background: "rgba(17,22,27,.5)", zIndex: "300", display: "flex", alignItems: "center", justifyContent: "center", padding: "20px", boxSizing: "border-box" }}><div onClick={v.stop} role="dialog" aria-modal="true" style={{ background: "#fff", borderRadius: "2px", width: "100%", maxWidth: v.dlg.width, maxHeight: "92vh", overflow: "auto", boxShadow: "0 25px 50px rgba(17,22,27,.3)", display: "flex", flexDirection: "column" }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px", padding: "22px 26px 0" }}><div><span style={{ fontSize: "10px", letterSpacing: ".22em", textTransform: "uppercase", fontWeight: "600", color: "#9C5F22" }}>{v.dlg.kicker}</span><h2 style={{ fontFamily: "'Cinzel',Georgia,serif", fontWeight: "500", fontSize: "18px", letterSpacing: ".06em", color: "#1D2A44", margin: "4px 0 0" }}>{v.dlg.title}</h2></div><button className="dc-h0" onClick={v.closeDialog} aria-label="Close" style={{ background: "none", border: "0", cursor: "pointer", color: "rgba(17,22,27,.5)", fontSize: "20px", padding: "2px", flexShrink: "0" }}><i className="ph ph-x"></i></button></div><div style={{ padding: "18px 26px 26px", display: "flex", flexDirection: "column", gap: "16px" }}>{v.dlg.book && <BookDialog v={v} />}{v.dlg.pay && <PayDialog v={v} />}{v.dlg.invoice && <InvoiceDialog v={v} />}{v.dlg.schedule && <ScheduleDialog v={v} />}{v.dlg.video && <VideoDialog v={v} />}{v.dlg.note && <NoteDialog v={v} />}{v.dlg.family && <FamilyDialog v={v} />}{v.dlg.upload && <UploadVideoDialog v={v} />}{v.dlg.addurl && <AddUrlDialog v={v} />}{v.dlg.editVideo && <EditVideoDialog v={v} />}{v.dlg.packages && <PackagesDialog v={v} />}{v.dlg.autopay && <AutopayDialog v={v} />}{v.dlg.enroll2fa && <SecurityDialog v={v} />}{v.dlg.migrate && <MigrateDialog v={v} />}{v.dlg.recovery && <RecoveryDialog v={v} />}</div></div></div></>
  );
}
