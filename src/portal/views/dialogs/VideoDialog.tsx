import { useEffect, useState } from "react";
import { api, errorText } from "../../api/client";
import type { VM } from "../../vm/types";

const frame = { aspectRatio: "16/9", background: "linear-gradient(135deg,#1D2A44,#11161B)", borderRadius: "2px", display: "flex", alignItems: "center", justifyContent: "center", position: "relative" } as const;

function youtubeEmbed(url: string) {
  const u = new URL(url);
  const id = u.hostname.includes("youtu.be") ? u.pathname.slice(1) : u.searchParams.get("v") ?? u.pathname.split("/").pop();
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id ?? "")}`;
}

export default function VideoDialog({ v }: { v: VM }) {
  const [source, setSource] = useState<{ kind: string; url: string } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!v.dv.id) return;
    let live = true;
    // Authorized per request. File playback uses a short-lived signed URL issued by the server.
    api(`/videos/${v.dv.id}/playback`).then((s) => live && setSource(s)).catch((e) => live && setError(errorText(e)));
    return () => { live = false; };
  }, [v.dv.id]);
  return (
    <>
      <div style={frame}>
        {source?.kind === "file" && <video src={source.url} controls controlsList="nodownload" style={{ width: "100%", height: "100%" }} />}
        {source?.kind === "external" && <iframe src={youtubeEmbed(source.url)} title={v.dv.title} allowFullScreen style={{ width: "100%", height: "100%", border: 0 }} />}
        {!source && (
          <span style={{ fontSize: "13px", color: "rgba(255,255,255,.75)", padding: "16px", textAlign: "center" }} aria-live="polite">
            {error || "Loading video…"}
          </span>
        )}
      </div>
      <div><span style={{ fontSize: "10px", letterSpacing: ".18em", textTransform: "uppercase", fontWeight: "600", color: "#9C5F22" }}>{v.dv.cat} · assigned {v.dv.assigned}</span><p style={{ margin: "6px 0 0", fontSize: "14px", lineHeight: "1.6", color: "rgba(17,22,27,.75)" }}>{v.dv.desc}</p></div>
      {v.dv.watchedMarked && <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "#4A6149", fontWeight: "500" }}><i className="ph-fill ph-check-circle"></i> Marked as watched</div>}
    </>
  );
}
