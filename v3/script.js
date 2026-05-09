/**
 * Vigdís v3 — minimal page JS.
 *
 * Three responsibilities:
 *
 *   1. Reveal-on-scroll for `.reveal` and `.numeral-rise`. The
 *      observer threshold is generous (15%) and we unwatch
 *      after the first intersection so elements never re-fade
 *      on scroll-back.
 *
 *   2. Sticky-header hairline. The masthead gains a 1px bottom
 *      rule once we've scrolled past the first 8px.
 *
 *   3. The form is handled by `assets/waitlist.js` separately —
 *      this file doesn't touch it.
 *
 * `prefers-reduced-motion: reduce` is honored at the CSS level,
 * so no special branch is needed here.
 */

(function () {
    'use strict';

    document.addEventListener('DOMContentLoaded', function () {

        // ----- Reveal-on-scroll ---------------------------------

        var reveals = document.querySelectorAll('.reveal, .numeral-rise');

        if ('IntersectionObserver' in window && reveals.length > 0) {
            var io = new IntersectionObserver(function (entries) {
                entries.forEach(function (entry) {
                    if (entry.isIntersecting) {
                        entry.target.classList.add('is-visible');
                        io.unobserve(entry.target);
                    }
                });
            }, {
                threshold: 0.15,
                rootMargin: '0px 0px -40px 0px'
            });

            reveals.forEach(function (el) { io.observe(el); });
        } else {
            reveals.forEach(function (el) { el.classList.add('is-visible'); });
        }

        // ----- Sticky-header hairline ---------------------------

        var masthead = document.getElementById('masthead');
        if (masthead) {
            var ticking = false;
            var apply = function () {
                masthead.classList.toggle('is-scrolled', window.scrollY > 8);
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
    });
})();
