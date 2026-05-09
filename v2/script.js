/**
 * Vigdís v2 — minimal page JS.
 *
 * Two responsibilities only:
 *
 *   1. Reveal-on-scroll.  Each `.reveal` element fades in once the
 *      first time it intersects the viewport.  No stagger, no
 *      slide, no scale — Japandi favors stillness, so the
 *      animation is a 700ms opacity + 8px lift, run once, then
 *      the observer un-watches the element.
 *
 *   2. Sticky-header hairline.  The header shows a 1px bottom
 *      rule only after the page has scrolled.  At rest, the
 *      header sits flush against the paper background with no
 *      visual seam.
 *
 * Reduced-motion preference is honored at the CSS level (every
 * `transition-duration` is forced to `0ms` inside
 * `@media (prefers-reduced-motion: reduce)`), so the JS doesn't
 * need a separate code path — the reveal class still toggles,
 * but the visual effect is instantaneous.
 */

(function () {
    'use strict';

    // ----- Reveal-on-scroll -------------------------------------

    var revealEls = document.querySelectorAll('.reveal');

    if ('IntersectionObserver' in window && revealEls.length > 0) {
        var observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (entry.isIntersecting) {
                    entry.target.classList.add('is-visible');
                    observer.unobserve(entry.target);
                }
            });
        }, {
            threshold: 0.12,
            rootMargin: '0px 0px -40px 0px'
        });

        revealEls.forEach(function (el) { observer.observe(el); });
    } else {
        // Older browsers without IntersectionObserver: skip the
        // animation entirely and render content immediately.
        revealEls.forEach(function (el) { el.classList.add('is-visible'); });
    }

    // ----- Sticky-header hairline -------------------------------

    var header = document.getElementById('site-header');
    if (header) {
        var ticking = false;
        var apply = function () {
            header.classList.toggle('is-scrolled', window.scrollY > 8);
            ticking = false;
        };
        window.addEventListener('scroll', function () {
            if (!ticking) {
                window.requestAnimationFrame(apply);
                ticking = true;
            }
        }, { passive: true });
        apply();
    }
})();
