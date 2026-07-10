import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Music,
  Sparkles,
  Users,
  Mail,
  Phone,
  ArrowRight,
  Menu,
  X,
  Calendar
} from "lucide-react";

declare global {
  interface Window {
    Calendly?: any;
  }
}

function CalendlyInlineWidget() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const loadWidget = () => {
      if (window.Calendly && containerRef.current) {
        containerRef.current.innerHTML = "";
        window.Calendly.initInlineWidget({
          url: "https://calendly.com/zane-luperconsulting?primary_color=2e4270",
          parentElement: containerRef.current,
          prefill: {},
          utm: {}
        });
      }
    };

    if (window.Calendly) {
      loadWidget();
    } else {
      const interval = setInterval(() => {
        if (window.Calendly) {
          loadWidget();
          clearInterval(interval);
        }
      }, 200);
      return () => clearInterval(interval);
    }
  }, []);

  return (
    <div 
      ref={containerRef} 
      className="w-full bg-white rounded-sm border border-[#11161B]/10 overflow-hidden shadow-sm"
      style={{ minWidth: "320px", height: "700px" }}
    />
  );
}

export default function App() {
  // Mobile menu display state
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  const scrollToSection = (id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth" });
    }
    setIsMobileMenuOpen(false);
  };

  const openCalendly = () => {
    if (window.Calendly) {
      window.Calendly.initPopupWidget({
        url: "https://calendly.com/zane-luperconsulting?primary_color=2e4270"
      });
    } else {
      window.open("https://calendly.com/zane-luperconsulting?primary_color=2e4270", "_blank");
    }
  };

  return (
    <div className="min-h-screen bg-[#F9F8F5] text-[#11161B] flex flex-col font-sans selection:bg-[#C27D38] selection:text-white">
      
      {/* SECTION 1: STICKY NAVIGATION HEADER */}
      <header id="nav-header" className="sticky top-0 z-50 bg-[#F9F8F5]/80 backdrop-blur-md border-b border-[#11161B]/5">
        <div className="max-w-7xl mx-auto px-6 h-20 flex items-center justify-between">
          {/* Brand Wordmark */}
          <button
            onClick={() => scrollToSection("hero-sec")}
            className="font-serif text-2xl tracking-widest text-[#1D2A44] hover:opacity-80 transition-opacity uppercase font-semibold cursor-pointer"
            id="brand-logo"
          >
            ZANE LUPER
          </button>

          {/* Nav Links Desktop */}
          <nav className="hidden md:flex items-center space-x-10 text-sm tracking-wider font-medium uppercase text-[#11161B]/80">
            <button onClick={() => scrollToSection("about-sec")} className="hover:text-[#C27D38] transition-colors duration-200 uppercase cursor-pointer">About</button>
            <button onClick={() => scrollToSection("lessons-sec")} className="hover:text-[#C27D38] transition-colors duration-200 uppercase cursor-pointer">Fiddle Styles</button>
            <button onClick={() => scrollToSection("whos-it-for-sec")} className="hover:text-[#C27D38] transition-colors duration-200 uppercase cursor-pointer">Who It's For</button>
            <button onClick={() => scrollToSection("rates-sec")} className="hover:text-[#C27D38] transition-colors duration-200 uppercase cursor-pointer">Rates</button>
            <button onClick={() => scrollToSection("studio-sec")} className="hover:text-[#C27D38] transition-colors duration-200 uppercase cursor-pointer">The Studio</button>
          </nav>

          {/* CTA Header Button */}
          <div className="hidden md:flex items-center">
            <button
              onClick={openCalendly}
              className="bg-[#1D2A44] hover:bg-[#C27D38] text-white px-7 py-3 tracking-widest uppercase font-serif text-xs transition-colors duration-300 font-semibold shadow-sm rounded-sm flex items-center gap-1.5"
              id="cta-head-btn"
            >
              <Calendar size={13} />
              <span>BOOK INTRO CALL</span>
            </button>
          </div>

          {/* Mobile Hamburger Toggle */}
          <button
            className="md:hidden text-[#1D2A44] p-1"
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            aria-label="Toggle Navigation Menu"
            id="mobile-nav-toggle"
          >
            {isMobileMenuOpen ? <X size={26} /> : <Menu size={26} />}
          </button>
        </div>
      </header>

      {/* Mobile Drawer Navigation overlay */}
      <AnimatePresence>
        {isMobileMenuOpen && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.2 }}
            className="md:hidden bg-[#F9F8F5]/95 backdrop-blur-lg fixed top-20 left-0 right-0 border-b border-[#11161B]/10 z-40 p-6 flex flex-col space-y-5 shadow-lg tracking-wider font-semibold uppercase text-[#11161B]/90"
            id="mobile-nav-drawer"
          >
            <button onClick={() => scrollToSection("about-sec")} className="text-left py-2 hover:text-[#C27D38] border-b border-[#11161B]/5">About</button>
            <button onClick={() => scrollToSection("lessons-sec")} className="text-left py-2 hover:text-[#C27D38] border-b border-[#11161B]/5">Fiddle Styles</button>
            <button onClick={() => scrollToSection("whos-it-for-sec")} className="text-left py-2 hover:text-[#C27D38] border-b border-[#11161B]/5">Who It's For</button>
            <button onClick={() => scrollToSection("rates-sec")} className="text-left py-2 hover:text-[#C27D38] border-b border-[#11161B]/5">Rates</button>
            <button onClick={() => scrollToSection("studio-sec")} className="text-left py-2 hover:text-[#C27D38] border-b border-[#11161B]/5">The Studio</button>
            <button onClick={() => { setIsMobileMenuOpen(false); openCalendly(); }} className="bg-[#1D2A44] text-white text-center py-4 text-xs tracking-widest font-bold inline-block hover:bg-[#C27D38] transition-colors rounded-sm flex items-center justify-center gap-1.5">
              <Calendar size={14} />
              <span>BOOK FREE INTRO CALL</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* SECTION 2: THE HERO SECTION */}
      <section id="hero-sec" className="scroll-mt-20 min-h-[calc(100vh-5rem)] relative overflow-hidden py-16 md:py-24 px-6 flex items-center justify-center border-b border-[#11161B]/5">
        <div className="max-w-7xl mx-auto w-full grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-16 items-center">
          {/* Left Text Column */}
          <div className="lg:col-span-7 flex flex-col items-start text-left lg:pr-6" id="hero-text-block">
            <div className="bg-[#4A6149]/10 text-[#4A6149] px-4 py-1 text-xs tracking-widest uppercase font-semibold mb-6 rounded-sm border border-[#4A6149]/15" id="sf-tag">
              FIDDLE LESSONS • SAN FRANCISCO, CA
            </div>
            <h1 className="font-serif text-5xl md:text-7xl lg:text-8xl font-normal tracking-wide text-[#1D2A44] leading-none" id="hero-title">
              ZANE <br /> LUPER
            </h1>
            <p className="font-serif text-xl md:text-2xl lg:text-3xl text-[#C27D38] italic font-medium tracking-wide leading-relaxed my-8 border-l-2 border-[#C27D38] pl-5 max-w-xl">
              Learn Scottish, Irish & Cape Breton fiddle from a performer and composer in the tradition.
            </p>
            
            {/* Conversion CTA Card */}
            <div className="w-full max-w-xl bg-white p-6 md:p-8 border border-[#11161B]/10 rounded-sm shadow-sm flex flex-col items-start gap-4 mt-2" id="hero-cta-card">
              <button
                onClick={openCalendly}
                className="w-full md:w-auto bg-[#C27D38] hover:bg-[#C27D38]/90 text-white font-medium text-xs tracking-widest uppercase px-8 py-4 duration-300 transition-colors cursor-pointer rounded-sm shadow-md flex items-center justify-center gap-2 group"
                id="hero-calendly-btn"
              >
                <Calendar size={14} />
                <span>Book a Free Intro Call</span>
                <ArrowRight size={14} className="group-hover:translate-x-1 transition-transform" />
              </button>
              <p className="text-xs text-[#11161B]/60 leading-relaxed mt-1">
                Pick a time that works for you, and I'll call you then. 15 minutes, no pressure — we'll talk about your goals and whether we're a good fit.
              </p>
            </div>
          </div>

          {/* Right Image Frame Column */}
          <div className="lg:col-span-5 flex justify-center lg:justify-end animate-fade-in">
            <div className="relative group max-w-sm md:max-w-md w-full">
              <div className="absolute -inset-1.5 bg-[#1D2A44]/5 border border-[#11161B]/5 rounded-sm transform rotate-1 translate-y-2 translate-x-3 transition-transform duration-500 group-hover:rotate-0 group-hover:translate-x-1 group-hover:translate-y-1"></div>
              <div className="absolute inset-0 bg-[#1D2A44] transform -rotate-2 rounded-sm -translate-y-1 -translate-x-2 shadow-lg transition-transform duration-500 group-hover:rotate-0 group-hover:translate-x-0 group-hover:translate-y-0"></div>
              <div className="relative bg-white p-3 md:p-4 rounded-sm shadow-xl overflow-hidden hover:scale-[1.01] transition-transform duration-300">
                <div className="aspect-[4/5] bg-stone-100 overflow-hidden relative">
                  <img
                    src="/_DSC6505.jpg"
                    alt="Zane Luper Portrait"
                    className="w-full h-full object-cover select-none pointer-events-none"
                  />
                </div>
                <div className="mt-3 md:mt-4 flex items-center justify-between text-[10px] tracking-widest text-[#11161B]/40 font-semibold uppercase">
                  <span>Studio Portrait Series</span>
                  <span>2026 Luper</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* SECTION 3: LINEAGE & ARTISTRY */}
      <section id="about-sec" className="scroll-mt-20 min-h-[calc(100vh-5rem)] flex items-center py-20 md:py-24 px-6 bg-white border-b border-[#11161B]/5">
        <div className="max-w-7xl mx-auto">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-16 items-start">
            {/* Left Image column: Timeless Monochrome layout */}
            <div className="lg:col-span-5 flex justify-center">
              <div className="relative max-w-md w-full">
                <div className="absolute -inset-3 bg-[#F9F8F5]/60 border border-black/5 rounded-sm transform translate-x-1 translate-y-1"></div>
                <div className="relative border border-[#11161B]/15 bg-white p-2.5 shadow-md">
                  <div className="aspect-[1.3/1] bg-stone-50 overflow-hidden relative">
                    <img
                      src="/_DSC6483.jpg"
                      alt="Monochrome snapshot of Zane Luper"
                      className="w-full h-full object-cover select-none pointer-events-none grayscale contrast-125 saturate-0"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Right Copy column */}
            <div className="lg:col-span-7 flex flex-col items-start text-left" id="lineage-copy">
              <h2 className="font-serif text-3xl md:text-5xl tracking-wide text-[#1D2A44] uppercase font-medium mb-8">LINEAGE & ARTISTRY</h2>
              <div className="space-y-6 font-normal leading-relaxed max-w-2xl text-sm md:text-base text-[#11161B]/75">
                <p>
                  I am a classically trained violinist who found my home in traditional music. I perform as one half of Brothers Luper, a San Francisco Baroq-Celtic duo, with my brother Cullen Luper.
                </p>
                <p>
                  I grew up in the Bay Area Scottish fiddle scene, including the San Francisco Scottish Fiddlers and Alasdair Fraser's fiddle camps. I compose original tunes in the tradition; I co-wrote "Six Point Buck," performed by Cullen Luper and Neil Pearlman at the 2024 Valley of the Moon Scottish Fiddling School.
                </p>
                <p className="italic text-[#11161B]/60">
                  My classical training is background that informs how I teach technique — it is not an offering. I focus on developing natural, tension-free physical technique, so you can play with ease and express the true spirit of traditional melodies.
                </p>
              </div>

              {/* The influence chip cloud */}
              <div className="mt-12 w-full pt-8 border-t border-[#11161B]/5" id="influence-chips">
                <h3 className="font-serif text-xs tracking-widest text-[#11161B]/40 font-semibold mb-5 uppercase">PEDIGREE & INFLUENCES</h3>
                <div className="flex flex-wrap gap-2.5 max-w-xl">
                  {["Heidi Wilcox", "Carla Moore", "Alasdair Fraser", "Athena Tergis", "Hanneke Cassel", "Kevin Henderson", "Kevin Burke", "Altan"].map((chip) => {
                    if (chip === "Alasdair Fraser" || chip === "Athena Tergis" || chip === "Carla Moore" || chip === "Kevin Burke" || chip === "Hanneke Cassel") {
                      const hrefMap: Record<string, string> = {
                        "Alasdair Fraser": "https://alasdairfraser.com/",
                        "Athena Tergis": "https://athenatergis.com/",
                        "Carla Moore": "https://www.carlamoore.net/",
                        "Kevin Burke": "https://www.kevinburke.com/",
                        "Hanneke Cassel": "https://www.hannekecassel.com/"
                      };
                      return (
                        <a
                          key={chip}
                          href={hrefMap[chip]}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="bg-[#F9F8F5]/80 text-[#1D2A44] border border-[#11161B]/15 hover:border-[#C27D38] hover:bg-[#C27D38]/5 hover:text-[#C27D38] px-4 py-2 text-xs tracking-wider rounded-sm font-semibold transition-all duration-200 shadow-sm flex items-center gap-1.5 cursor-pointer"
                          id={`${chip.toLowerCase().replace(/\s+/g, "-")}-link`}
                        >
                          <span>{chip}</span>
                          <span className="text-[10px] text-[#C27D38] font-bold">↗</span>
                        </a>
                      );
                    }
                    return (
                      <span
                        key={chip}
                        className="bg-[#F9F8F5]/80 text-[#11161B]/85 border border-[#11161B]/10 px-4 py-2 text-xs tracking-wider rounded-sm font-medium hover:border-[#C27D38] hover:text-[#C27D38] transition-colors duration-200"
                      >
                        {chip}
                      </span>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* SECTION 4: FIDDLE STYLES & TRADITIONS */}
      <section id="lessons-sec" className="scroll-mt-20 py-20 md:py-24 px-6 bg-[#F9F8F5]/60 border-b border-[#11161B]/5">
        <div className="max-w-7xl mx-auto text-center w-full">
          <div className="mb-12 inline-block">
            <span className="text-xs font-semibold tracking-[0.25em] text-[#C27D38] uppercase block mb-2">Living Traditions</span>
            <h2 className="font-serif text-3xl md:text-5xl tracking-wide text-[#1D2A44] uppercase font-medium">Fiddle Styles</h2>
            <div className="w-24 h-[3px] bg-[#C27D38] mx-auto mt-4 rounded-full"></div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 text-left mt-4" id="cards-container">
            {/* Style 1: Scottish Fiddle */}
            <div className="bg-white p-8 border border-[#11161B]/5 shadow-sm hover:-translate-y-1 hover:shadow-md transition-all duration-300 flex flex-col justify-between group">
              <div>
                <div className="w-12 h-12 rounded-sm bg-[#C27D38]/10 text-[#C27D38] flex items-center justify-center mb-6 group-hover:bg-[#C27D38] group-hover:text-white transition-colors duration-300">
                  <Music className="w-5 h-5" />
                </div>
                <h3 className="font-serif text-lg tracking-wider text-[#1D2A44] uppercase font-semibold mb-4">Scottish Fiddle</h3>
                <p className="text-sm text-[#11161B]/70 leading-relaxed">
                  Focus on the powerful lift, snap-bowings, and rhythmic drive unique to the Scottish fiddle tradition. From Strathspeys with their energetic Scotch snaps to elegant pastoral airs and fiery reels, you'll learn the techniques that drive traditional assemblies and dance halls.
                </p>
              </div>
              <div className="mt-8 flex items-center text-xs tracking-widest uppercase text-[#C27D38] font-bold select-none cursor-pointer hover:underline" onClick={() => scrollToSection("booking-sec")}>
                <span>INQUIRE LESSONS</span>
                <ArrowRight size={14} className="ml-1.5" />
              </div>
            </div>

            {/* Style 2: Irish Fiddle */}
            <div className="bg-white p-8 border border-[#11161B]/5 shadow-sm hover:-translate-y-1 hover:shadow-md transition-all duration-300 flex flex-col justify-between group">
              <div>
                <div className="w-12 h-12 rounded-sm bg-[#C27D38]/10 text-[#C27D38] flex items-center justify-center mb-6 group-hover:bg-[#C27D38] group-hover:text-white transition-colors duration-300">
                  <Sparkles className="w-5 h-5" />
                </div>
                <h3 className="font-serif text-lg tracking-wider text-[#1D2A44] uppercase font-semibold mb-4">Irish Fiddle</h3>
                <p className="text-sm text-[#11161B]/70 leading-relaxed">
                  Delve deep into the ornamentation, phrasing, and regional dialects of the Irish fiddle style. Master standard ornamentation like cuts, rolls, cranns, and triplets, alongside dynamic bowing structures and traditional session etiquette.
                </p>
              </div>
              <div className="mt-8 flex items-center text-xs tracking-widest uppercase text-[#C27D38] font-bold select-none cursor-pointer hover:underline" onClick={() => scrollToSection("booking-sec")}>
                <span>EXPLORE TECHNIQUES</span>
                <ArrowRight size={14} className="ml-1.5" />
              </div>
            </div>

            {/* Style 3: Cape Breton Fiddle */}
            <div className="bg-white p-8 border border-[#11161B]/5 shadow-sm hover:-translate-y-1 hover:shadow-md transition-all duration-300 flex flex-col justify-between group">
              <div>
                <div className="w-12 h-12 rounded-sm bg-[#C27D38]/10 text-[#C27D38] flex items-center justify-center mb-6 group-hover:bg-[#C27D38] group-hover:text-white transition-colors duration-300">
                  <Users className="w-5 h-5" />
                </div>
                <h3 className="font-serif text-lg tracking-wider text-[#1D2A44] uppercase font-semibold mb-4">Cape Breton Fiddle</h3>
                <p className="text-sm text-[#11161B]/70 leading-relaxed">
                  Master the highly rhythmic, step-dance-driven accents and Gaelic-influenced phrasing of the Cape Breton style. We'll examine the syncopations, triplets, and specific bow-retakes that make this direct descendant of Highland Scottish music so infectious and unique.
                </p>
              </div>
              <div className="mt-8 flex items-center text-xs tracking-widest uppercase text-[#C27D38] font-bold select-none cursor-pointer hover:underline" onClick={() => scrollToSection("booking-sec")}>
                <span>EXPLORE LESSONS</span>
                <ArrowRight size={14} className="ml-1.5" />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* SECTION 5: WHO IT'S FOR */}
      <section id="whos-it-for-sec" className="scroll-mt-20 py-20 md:py-24 px-6 bg-white border-b border-[#11161B]/5">
        <div className="max-w-7xl mx-auto w-full text-center">
          <div className="mb-12 inline-block">
            <span className="text-xs font-semibold tracking-[0.25em] text-[#C27D38] uppercase block mb-2">CUSTOM TAILORED INSTRUCTION</span>
            <h2 className="font-serif text-3xl md:text-5xl tracking-wide text-[#1D2A44] uppercase font-medium">WHO IT'S FOR</h2>
            <div className="w-24 h-[3px] bg-[#C27D38] mx-auto mt-4 rounded-full"></div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 text-left mt-4">
            {/* Target 1: Complete Beginners */}
            <div className="bg-[#F9F8F5]/80 p-8 border border-[#11161B]/10 rounded-sm hover:border-[#C27D38]/30 transition-colors">
              <h3 className="font-serif text-xl text-[#1D2A44] font-semibold mb-4 uppercase tracking-wide">Complete Beginners</h3>
              <p className="text-sm text-[#11161B]/75 leading-relaxed">
                <strong>Adults and kids are warmly welcome.</strong> You don't need any musical background or prior violin training to start. We will begin with standard instrument setup, relaxed posture, bow ergonomics, and building your first traditional tunes entirely by ear from day one.
              </p>
            </div>

            {/* Target 2: Classically Trained Violinists */}
            <div className="bg-[#1D2A44] text-white p-8 border border-transparent rounded-sm shadow-md relative overflow-hidden">
              <div className="absolute top-0 right-0 bg-[#C27D38] text-white text-[9px] font-bold tracking-[0.15em] px-3 py-1 rounded-bl-sm uppercase">
                SPECIALIZATION
              </div>
              <h3 className="font-serif text-xl text-[#C27D38] font-semibold mb-4 uppercase tracking-wide">Classically Trained</h3>
              <p className="text-sm text-white/80 leading-relaxed">
                <strong>Transition from sheet music to a living tradition.</strong> If you are a classically trained violinist looking to find your traditional fiddle voice, you are in the right place. Having made this exact transition myself, I understand how to leverage your technical foundations while helping you break free from the page to play by ear, feel the groove, and find your own stylistic ornaments.
              </p>
            </div>

            {/* Target 3: Experienced Fiddlers */}
            <div className="bg-[#F9F8F5]/80 p-8 border border-[#11161B]/10 rounded-sm hover:border-[#C27D38]/30 transition-colors">
              <h3 className="font-serif text-xl text-[#1D2A44] font-semibold mb-4 uppercase tracking-wide">Experienced Fiddlers</h3>
              <p className="text-sm text-[#11161B]/75 leading-relaxed">
                <strong>Go deeper into traditional idioms.</strong> For intermediate and advanced players wanting to refine their Scottish, Irish, or Cape Breton styles. We will focus on detailed ornamentation (cuts, rolls, double stops), complex syncopations, tune variations, and traditional phrasing.
              </p>
            </div>
          </div>

          {/* Zoom Lesson Callout */}
          <div className="mt-12 p-6 bg-[#4A6149]/5 border border-[#4A6149]/15 rounded-sm max-w-2xl mx-auto text-center" id="zoom-callout">
            <p className="text-sm text-[#4A6149] font-medium">
              📍 San Francisco Bay Area lessons are conducted in-person. <strong>Online lessons over Zoom</strong> are fully available for dedicated students outside the region.
            </p>
          </div>

          {/* Mid-page Calendly button */}
          <div className="mt-12 flex flex-col items-center justify-center gap-4">
            <button
              onClick={openCalendly}
              className="bg-[#C27D38] hover:bg-[#C27D38]/90 text-white font-medium text-xs tracking-widest uppercase px-8 py-4 duration-300 transition-colors cursor-pointer rounded-sm shadow-sm flex items-center justify-center gap-2 group"
              id="mid-calendly-btn"
            >
              <Calendar size={14} />
              <span>Book a Free Intro Call</span>
              <ArrowRight size={12} className="group-hover:translate-x-1 transition-transform" />
            </button>
            <p className="text-xs text-[#11161B]/60 max-w-md">
              Pick a time that works for you, and I'll call you then. 15 minutes, no pressure — we'll talk about your goals and whether we're a good fit.
            </p>
          </div>
        </div>
      </section>

      {/* SECTION 6: VIDEO SECTION */}
      <section id="video-sec" className="scroll-mt-20 py-20 md:py-24 px-6 bg-[#F9F8F5]/40 border-b border-[#11161B]/5">
        <div className="max-w-7xl mx-auto text-center">
          <div className="mb-12 inline-block">
            <span className="text-xs font-semibold tracking-[0.25em] text-[#C27D38] uppercase block mb-2">Watch & Listen</span>
            <h2 className="font-serif text-3xl md:text-5xl tracking-wide text-[#1D2A44] uppercase font-medium">ORIGINAL COMPOSITIONS</h2>
            <div className="w-24 h-[3px] bg-[#C27D38] mx-auto mt-4 rounded-full"></div>
          </div>

          {/* Responsive embed wrapper */}
          <div className="aspect-video w-full max-w-3xl mx-auto rounded-sm overflow-hidden shadow-lg border border-[#11161B]/5 bg-black">
            <iframe
              width="100%"
              height="100%"
              src="https://www.youtube.com/embed/5G1_m4YhITU"
              title="Six Point Buck - performed by Cullen Luper and Neil Pearlman"
              frameBorder="0"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
              loading="lazy"
            ></iframe>
          </div>

          {/* Caption */}
          <p className="mt-6 text-xs md:text-sm text-[#11161B]/60 italic max-w-2xl mx-auto leading-relaxed">
            Co-writer Zane Luper's original tune <strong>"Six Point Buck"</strong> performed live by Cullen Luper (fiddle) and Neil Pearlman (piano) at the 2024 Valley of the Moon Scottish Fiddling School.
          </p>
        </div>
      </section>

      {/* SECTION 7: RATES SECTION */}
      <section id="rates-sec" className="scroll-mt-20 py-20 md:py-24 px-6 bg-white border-b border-[#11161B]/5">
        <div className="max-w-7xl mx-auto text-center">
          <div className="mb-8 inline-block">
            <span className="text-xs font-semibold tracking-[0.25em] text-[#C27D38] uppercase block mb-2">TUITION INVESTMENT</span>
            <h2 className="font-serif text-3xl md:text-5xl tracking-wide text-[#1D2A44] uppercase font-medium">SIMPLE RATES</h2>
            <div className="w-24 h-[3px] bg-[#C27D38] mx-auto mt-4 rounded-full"></div>
          </div>

          <div className="bg-[#F9F8F5] border border-[#11161B]/15 p-8 md:p-12 max-w-3xl mx-auto text-center rounded-sm shadow-sm my-8">
            <p className="font-serif text-2xl md:text-4xl text-[#1D2A44] font-medium tracking-wide">
              $100 / hour <span className="text-[#C27D38]">·</span> $55 / half hour
            </p>
            <p className="text-xs md:text-sm font-sans text-[#11161B]/60 mt-3 font-normal italic">
              (half hour sessions are great for kids and beginners)
            </p>
            <div className="border-t border-[#11161B]/10 mt-6 pt-4 flex flex-col sm:flex-row items-center justify-center gap-4 sm:gap-8 text-xs text-[#11161B]/70 font-semibold uppercase tracking-wider">
              <div className="flex items-center space-x-2">
                <span className="w-2 h-2 rounded-full bg-[#C27D38]"></span>
                <span>No hidden fees</span>
              </div>
              <div className="flex items-center space-x-2">
                <span className="w-2 h-2 rounded-full bg-[#C27D38]"></span>
                <span>$10 discount if paid in cash</span>
              </div>
            </div>
          </div>

          {/* Calendly Button in rates */}
          <div className="mt-8 flex flex-col items-center justify-center gap-4">
            <button
              onClick={openCalendly}
              className="bg-[#C27D38] hover:bg-[#C27D38]/90 text-white font-medium text-xs tracking-widest uppercase px-8 py-4 duration-300 transition-colors cursor-pointer rounded-sm shadow-sm flex items-center justify-center gap-2 group"
              id="rates-calendly-btn"
            >
              <Calendar size={14} />
              <span>Book a Free Intro Call</span>
              <ArrowRight size={12} className="group-hover:translate-x-1 transition-transform" />
            </button>
            <p className="text-xs text-[#11161B]/60 max-w-md">
              Pick a time that works for you, and I'll call you then. 15 minutes, no pressure — we'll talk about your goals and whether we're a good fit.
            </p>
          </div>
        </div>
      </section>

      {/* SECTION 8: MEET THE CRITICS */}
      <section id="studio-sec" className="scroll-mt-20 min-h-[calc(100vh-5rem)] flex items-center py-24 md:py-32 px-6 md:px-12 bg-[#11161B] text-white relative overflow-hidden">
        {/* Subtle dot matrix grid background inside piano black block */}
        <div className="absolute inset-0 opacity-[0.06] select-none pointer-events-none" style={{ backgroundImage: "radial-gradient(circle, white 1px, transparent 1px)", backgroundSize: "24px 24px" }}></div>
        <div className="max-w-7xl mx-auto relative z-10">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-16 items-center">
            {/* Left Content column */}
            <div className="lg:col-span-6 text-left" id="critics-content">
              <div className="mb-6">
                <span className="text-xs font-semibold tracking-[0.25em] text-[#C27D38] uppercase block">THE STUDIO</span>
                <span className="text-sm font-light text-white/60 tracking-wide mt-1 block">Based in San Francisco</span>
              </div>
              <h2 className="font-serif text-4xl md:text-5xl tracking-wide text-white uppercase font-normal mb-8 leading-tight">MEET THE CRITICS</h2>
              <p className="text-sm md:text-base text-white/70 font-light leading-relaxed mb-10 max-w-lg">
                The studio is more than just a room—it's an ecosystem. I have been formed under the keen eyes of my two little balls of fur and I hope to pass on their teachings to you.
              </p>
              <div className="flex items-center space-x-4">
                <span className="w-12 h-[1px] bg-[#C27D38]"></span>
                <span className="font-serif text-xs tracking-widest text-[#C27D38] font-medium uppercase">Siberian Authority</span>
              </div>
            </div>

            {/* Right Asset treatment: Piano Cats image framing */}
            <div className="lg:col-span-6 flex justify-center lg:justify-end">
              <div className="relative group max-w-sm md:max-w-md w-full">
                <div className="absolute -inset-1.5 rounded-sm border border-[#C27D38]/40 bg-transparent transform -translate-x-3 -translate-y-3 group-hover:translate-x-1 group-hover:translate-y-1 transition-transform duration-500"></div>
                <div className="relative border border-[#C27D38] bg-[#11161B] p-3.5 rounded-sm shadow-2xl">
                  <div className="aspect-[4/3] bg-stone-900 overflow-hidden rounded-xs">
                    <img
                      src="/_DSC6337_1.jpg"
                      alt="Two Maine Coon cats lounge on the upright piano while Zane plays"
                      className="w-full h-full object-cover select-none pointer-events-none"
                    />
                  </div>
                  <div className="mt-3 flex items-center justify-between text-[9px] tracking-widest text-[#C27D38]/75 font-semibold uppercase">
                    <span>Lounge Supervision Dept.</span>
                    <span>100% Quality Audited</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* SECTION 9: READY TO BEGIN? & INTERACTIVE BOOKING */}
      <section id="booking-sec" className="scroll-mt-20 py-20 md:py-24 px-6 bg-[#1D2A44] text-white relative">
        <div className="max-w-7xl mx-auto w-full">
          <div className="text-center mb-12 max-w-2xl mx-auto">
            <h2 className="font-serif text-4xl md:text-5xl tracking-wide text-white uppercase font-normal mb-6">READY TO BEGIN?</h2>
            <p className="text-sm md:text-base text-white/70 font-light leading-relaxed mb-8">
              Pick a time that works for you directly below. 15 minutes, no pressure — we'll talk about your goals and whether we're a good fit. You can also reach out via email or phone.
            </p>
          </div>

          {/* Embedded Calendly Inline Widget */}
          <div className="mb-16">
            <CalendlyInlineWidget />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl mx-auto" id="contact-cards-container">
            {/* Card A: Email */}
            <a href="mailto:zane@sftradmusic.com" className="border border-white/10 hover:border-[#C27D38] bg-[#1d2a44]/70 p-8 rounded-sm text-left flex flex-col justify-between hover:bg-[#182842] hover:-translate-y-1 transition-all duration-300 group cursor-pointer">
              <div>
                <div className="w-10 h-10 rounded-sm bg-white/5 text-[#C27D38] flex items-center justify-center mb-6 group-hover:bg-[#C27D38] group-hover:text-white transition-colors duration-300">
                  <Mail className="w-5 h-5" />
                </div>
                <span className="text-white/45 text-xs tracking-widest font-semibold uppercase block mb-1">EMAIL ADDRESS</span>
                <p className="font-serif text-lg md:text-xl tracking-wider text-white group-hover:text-[#C27D38] transition-colors font-medium">ZANE@SFTRADMUSIC.COM</p>
              </div>
              <div className="mt-8 flex items-center justify-start text-[10px] tracking-widest text-[#a88d5f] font-bold">
                <span>SEND DIRECT MAIL</span>
                <ArrowRight size={12} className="ml-1.5" />
              </div>
            </a>

            {/* Card B: Phone */}
            <a href="tel:+14154390060" className="border border-white/10 hover:border-[#C27D38] bg-[#1d2a44]/70 p-8 rounded-sm text-left flex flex-col justify-between hover:bg-[#1a2842] hover:-translate-y-1 transition-all duration-300 group cursor-pointer">
              <div>
                <div className="w-10 h-10 rounded-sm bg-white/5 text-[#C27D38] flex items-center justify-center mb-6 group-hover:bg-[#C27D38] group-hover:text-white transition-colors duration-300">
                  <Phone className="w-5 h-5" />
                </div>
                <span className="text-white/45 text-xs tracking-widest font-semibold uppercase block mb-1">PHONE OFFICE</span>
                <p className="font-serif text-lg md:text-xl tracking-wider text-white group-hover:text-[#C27D38] transition-colors font-medium">+1 (415) 439-0060</p>
              </div>
              <div className="mt-8 flex items-center justify-start text-[10px] tracking-widest text-[#a88d5f] font-bold">
                <span>CALL VERBALLY</span>
                <ArrowRight size={12} className="ml-1.5" />
              </div>
            </a>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="mt-auto bg-[#11161B] py-12 px-6 border-t border-white/5 text-white/50 text-xs">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between space-y-6 md:space-y-0 text-center md:text-left">
          <div>
            <p className="font-sans text-[11px] tracking-widest font-semibold uppercase">
              © 2026 ZANE LUPER, HANDCRAFTED IN SAN FRANCISCO.
            </p>
          </div>
          {/* Social Links Matrix */}
          <div className="flex space-x-8 uppercase font-bold tracking-widest text-[11px] text-white/60">
            <a href="https://www.instagram.com/sf.tradmusic/?hl=en" target="_blank" rel="noopener noreferrer" className="hover:text-[#C27D38] transition-colors">INSTAGRAM</a>
            <a href="https://www.youtube.com/@sftradmusic" target="_blank" rel="noopener noreferrer" className="hover:text-[#C27D38] transition-colors">YOUTUBE</a>
          </div>
        </div>
      </footer>

    </div>
  );
}
