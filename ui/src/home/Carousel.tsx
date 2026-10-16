import { Children, useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

/** Next slide index for a keyboard key, or null when the key is not handled. */
export function carouselKeyTarget(key: string, index: number, count: number): number | null {
  const last = Math.max(0, count - 1);
  switch (key) {
    case "ArrowRight": return Math.min(last, index + 1);
    case "ArrowLeft": return Math.max(0, index - 1);
    case "Home": return 0;
    case "End": return last;
    default: return null;
  }
}

/** Index of the slide whose left edge is closest to the current scroll position. */
export function nearestSlide(scrollLeft: number, offsets: number[]): number {
  let best = 0;
  offsets.forEach((o, i) => { if (Math.abs(o - scrollLeft) < Math.abs(offsets[best]! - scrollLeft)) best = i; });
  return best;
}

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function Carousel({ label, children }: { label: string; children: ReactNode }) {
  const { t } = useTranslation();
  const track = useRef<HTMLDivElement>(null);
  const slides = Children.toArray(children);
  const count = slides.length;
  const [active, setActive] = useState(0);
  const [atEnd, setAtEnd] = useState(false);

  const sync = useCallback(() => {
    const el = track.current;
    if (!el) return;
    const items = Array.from(el.children) as HTMLElement[];
    const base = items[0]?.offsetLeft ?? 0;
    setActive(nearestSlide(el.scrollLeft, items.map((c) => c.offsetLeft - base)));
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    sync();
    const el = track.current;
    el?.addEventListener("scroll", sync, { passive: true });
    window.addEventListener("resize", sync);
    return () => { el?.removeEventListener("scroll", sync); window.removeEventListener("resize", sync); };
  }, [sync]);

  const go = (i: number) => {
    const el = track.current;
    const items = el ? (Array.from(el.children) as HTMLElement[]) : [];
    const target = items[i];
    if (!el || !target) return;
    el.scrollTo({ left: target.offsetLeft - (items[0]?.offsetLeft ?? 0), behavior: reducedMotion() ? "auto" : "smooth" });
    setActive(i);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return; // don't hijack keys inside inputs/buttons in a card
    const n = carouselKeyTarget(e.key, active, count);
    if (n === null) return;
    e.preventDefault();
    go(n);
  };

  return (
    <section className="pz-carousel" aria-roledescription="carousel" aria-label={label} data-testid="services-carousel">
      <div className="pz-carousel-track pz-services" ref={track} tabIndex={0} onKeyDown={onKey} aria-label={t("home.carousel.hint")}>
        {slides.map((s, i) => (
          <div key={i} className="pz-slide" role="group" aria-roledescription="slide" aria-label={t("home.carousel.slide", { n: i + 1, total: count })}>
            {s}
          </div>
        ))}
      </div>
      <div className="pz-carousel-nav">
        <button type="button" className="pz-arrow" onClick={() => go(Math.max(0, active - 1))} disabled={active === 0} aria-label={t("home.carousel.prev")} data-testid="carousel-prev">‹</button>
        <div className="pz-dots" role="group" aria-label={t("home.carousel.dots")}>
          {slides.map((_, i) => (
            <button key={i} type="button" className={`pz-dot${i === active ? " on" : ""}`} aria-label={t("home.carousel.slide", { n: i + 1, total: count })} aria-current={i === active ? "true" : undefined} onClick={() => go(i)} data-testid="carousel-dot" />
          ))}
        </div>
        <button type="button" className="pz-arrow" onClick={() => go(Math.min(count - 1, active + 1))} disabled={atEnd || active === count - 1} aria-label={t("home.carousel.next")} data-testid="carousel-next">›</button>
      </div>
    </section>
  );
}
