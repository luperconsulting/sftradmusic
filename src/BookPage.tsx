import React, { useState } from "react";
import { ArrowLeft } from "lucide-react";

export default function BookPage() {
  // Hide the "Loading calendar" placeholder once the GoHighLevel iframe has loaded
  const [calendarLoaded, setCalendarLoaded] = useState(false);

  return (
    <div className="h-dvh bg-[#1D2A44] text-white flex flex-col font-sans selection:bg-[#C27D38] selection:text-white">
      {/* Skip link: visually hidden until focused with the keyboard */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[60] focus:bg-[#1D2A44] focus:text-white focus:px-4 focus:py-2 focus:rounded-sm focus:text-xs focus:tracking-widest focus:uppercase focus:font-semibold"
      >
        Skip to content
      </a>

      {/* HEADER */}
      <header className="shrink-0 bg-[#F9F8F5] border-b border-[#11161B]/5">
        <div className="max-w-7xl mx-auto px-6 h-16 md:h-20 flex items-center justify-between">
          <a
            href="/"
            className="font-serif text-xl md:text-2xl tracking-widest text-[#1D2A44] hover:opacity-80 transition-opacity uppercase font-semibold"
            id="brand-logo"
          >
            ZANE LUPER
          </a>
          <a
            href="/"
            className="flex items-center gap-1.5 text-xs tracking-widest uppercase font-semibold text-[#11161B]/80 hover:text-[#9C5F22] transition-colors py-3"
          >
            <ArrowLeft size={14} />
            <span>Back to site</span>
          </a>
        </div>
      </header>

      {/* The calendar card fills whatever height is left below the header, so the page itself never scrolls */}
      <main id="main-content" className="flex-1 min-h-0 flex flex-col px-4 md:px-6 py-4 md:py-6">
        <h1 className="shrink-0 font-serif text-xl md:text-2xl tracking-wide text-white uppercase font-normal text-center mb-3 md:mb-4">
          Book a Free Intro Call
        </h1>

        <div className="flex-1 min-h-0 w-full max-w-6xl mx-auto bg-white rounded-sm shadow-lg overflow-hidden relative" id="booking-calendar">
          {!calendarLoaded && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-[#11161B]/60" aria-live="polite">
              <span className="w-8 h-8 rounded-full border-2 border-[#C27D38]/30 border-t-[#9C5F22] animate-spin" aria-hidden="true"></span>
              <span className="text-xs tracking-widest uppercase font-semibold">Loading calendar…</span>
            </div>
          )}
          <iframe
            src="https://api.leadconnectorhq.com/widget/booking/vc5JhcEjhKFs3MpJyj9p"
            title="Book intro call"
            className="w-full h-full border-0 relative"
            id="sftradmusic-intro-call"
            onLoad={() => setCalendarLoaded(true)}
          ></iframe>
        </div>
      </main>
    </div>
  );
}
