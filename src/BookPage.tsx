import React, { useEffect } from "react";
import { ArrowLeft, Mail, Phone } from "lucide-react";

export default function BookPage() {
  // GoHighLevel's embed helper: listens for the booking iframe and resizes it to its content
  useEffect(() => {
    const script = document.createElement("script");
    script.src = "https://link.msgsndr.com/js/form_embed.js";
    script.async = true;
    document.body.appendChild(script);
    return () => {
      script.remove();
    };
  }, []);

  return (
    <div className="min-h-screen bg-[#1D2A44] text-white flex flex-col font-sans selection:bg-[#C27D38] selection:text-white">
      {/* Skip link: visually hidden until focused with the keyboard */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[60] focus:bg-[#1D2A44] focus:text-white focus:px-4 focus:py-2 focus:rounded-sm focus:text-xs focus:tracking-widest focus:uppercase focus:font-semibold"
      >
        Skip to content
      </a>

      {/* HEADER */}
      <header className="sticky top-0 z-50 bg-[#F9F8F5]/95 backdrop-blur-md border-b border-[#11161B]/5">
        <div className="max-w-7xl mx-auto px-6 h-20 flex items-center justify-between">
          <a
            href="/"
            className="font-serif text-2xl tracking-widest text-[#1D2A44] hover:opacity-80 transition-opacity uppercase font-semibold"
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

      <main id="main-content" className="flex-1 py-16 md:py-24 px-6">
        <div className="max-w-7xl mx-auto w-full">
          <div className="text-center mb-12 max-w-2xl mx-auto">
            <span className="text-xs font-semibold tracking-[0.25em] text-[#E0A363] uppercase block mb-3">Free Intro Call</span>
            <h1 className="font-serif text-4xl md:text-5xl tracking-wide text-white uppercase font-normal mb-6">BOOK AN INTRO CALL</h1>
            <p className="text-sm md:text-base text-white/70 font-light leading-relaxed">
              Pick a time that works for you, and we'll talk about your goals and whether we're a good fit. 15 minutes, no pressure.
            </p>
          </div>

          {/* Embedded intro-call calendar (GoHighLevel). form_embed.js resizes the iframe to fit. */}
          <div className="max-w-3xl mx-auto mb-16 bg-white rounded-sm shadow-lg overflow-hidden" id="booking-calendar">
            <iframe
              src="https://api.leadconnectorhq.com/widget/booking/vc5JhcEjhKFs3MpJyj9p"
              title="Book intro call"
              style={{ width: "100%", minHeight: "700px", border: "none", overflow: "hidden" }}
              scrolling="no"
              id="sftradmusic-intro-call"
            ></iframe>
          </div>

          <p className="text-center text-xs text-white/60 mb-8 uppercase tracking-widest font-semibold">Or reach out directly</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl mx-auto" id="contact-cards-container">
            <a href="mailto:zane@sftradmusic.com" className="border border-white/10 hover:border-[#C27D38] bg-[#1d2a44]/70 p-8 rounded-sm text-left flex flex-col justify-between hover:bg-[#182842] hover:-translate-y-1 transition-all duration-300 group cursor-pointer">
              <div>
                <div className="w-10 h-10 rounded-sm bg-white/5 text-[#E0A363] flex items-center justify-center mb-6 group-hover:bg-[#9C5F22] group-hover:text-white transition-colors duration-300">
                  <Mail className="w-5 h-5" />
                </div>
                <span className="text-white/70 text-xs tracking-widest font-semibold uppercase block mb-1">EMAIL ADDRESS</span>
                <p className="font-serif text-lg md:text-xl tracking-wider text-white group-hover:text-[#E0A363] transition-colors font-medium">ZANE@SFTRADMUSIC.COM</p>
              </div>
            </a>
            <a href="tel:+14154390060" className="border border-white/10 hover:border-[#C27D38] bg-[#1d2a44]/70 p-8 rounded-sm text-left flex flex-col justify-between hover:bg-[#1a2842] hover:-translate-y-1 transition-all duration-300 group cursor-pointer">
              <div>
                <div className="w-10 h-10 rounded-sm bg-white/5 text-[#E0A363] flex items-center justify-center mb-6 group-hover:bg-[#9C5F22] group-hover:text-white transition-colors duration-300">
                  <Phone className="w-5 h-5" />
                </div>
                <span className="text-white/70 text-xs tracking-widest font-semibold uppercase block mb-1">PHONE OFFICE</span>
                <p className="font-serif text-lg md:text-xl tracking-wider text-white group-hover:text-[#E0A363] transition-colors font-medium">+1 (415) 439-0060</p>
              </div>
            </a>
          </div>
        </div>
      </main>

      {/* FOOTER */}
      <footer className="mt-auto bg-[#11161B] py-12 px-6 border-t border-white/5 text-white/50 text-xs">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between space-y-6 md:space-y-0 text-center md:text-left">
          <p className="font-sans text-[11px] tracking-widest font-semibold uppercase">
            © 2026 ZANE LUPER, HANDCRAFTED IN SAN FRANCISCO.
          </p>
          <div className="flex space-x-8 uppercase font-bold tracking-widest text-[11px] text-white/60">
            <a href="https://www.instagram.com/sf.tradmusic/?hl=en" target="_blank" rel="noopener noreferrer" className="hover:text-[#E0A363] transition-colors">INSTAGRAM</a>
            <a href="https://www.youtube.com/@sftradmusic" target="_blank" rel="noopener noreferrer" className="hover:text-[#E0A363] transition-colors">YOUTUBE</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
