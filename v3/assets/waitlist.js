/**
 * Vigdís v3 — waitlist handler.
 *
 * Same Google Apps Script endpoint as before. Posts the email,
 * fades the form away on success, replaces the row with a
 * single line of copy. No confetti, no scaling — Neo-Geo
 * favors precise, modular feedback.
 */

(function () {
    'use strict';

    var ENDPOINT = 'https://script.google.com/macros/s/AKfycbwRnbN7F1WMgHIGQ8ebJw2Zpl3q_CcobxSlAYqwcDuX9PSQr5Y-Yha5xGFOHdAgyoeimA/exec';

    var EMAIL_RE = /^(([^<>()[\]\\.,;:\s@"]+(\.?[^<>()[\]\\.,;:\s@"]+)*)|.(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;

    function isValidEmail(value) {
        return EMAIL_RE.test(String(value).toLowerCase());
    }

    document.addEventListener('DOMContentLoaded', function () {
        var form = document.getElementById('waitlist-form-cta');
        if (!form) return;

        var input = form.querySelector('input[type="email"]');
        var submit = form.querySelector('button[type="submit"]');
        var message = document.getElementById('waitlist-message');
        if (!input || !submit) return;

        var loadingText = form.getAttribute('data-loading') || 'Subscribing...';
        var successText = form.getAttribute('data-success') || 'Thanks. We will be in touch.';
        var errorText = form.getAttribute('data-error') || 'Something went wrong. Please try again.';

        var invalidText = document.documentElement.lang.indexOf('is') === 0
            ? 'Vinsamlegast sláðu inn gilt netfang.'
            : 'Please enter a valid email address.';

        var setMessage = function (text, tone) {
            if (!message) return;
            message.textContent = text || '';
            // On the dark CTA background, success is paper-cream,
            // error is a soft coral, neutral is muted.
            message.style.color = tone === 'error'
                ? '#F0918F'
                : tone === 'success'
                    ? '#F4EFE3'
                    : 'rgba(244, 239, 227, 0.6)';
        };

        var setLoading = function (loading) {
            submit.disabled = loading;
            submit.style.opacity = loading ? '0.5' : '1';
        };

        input.addEventListener('input', function () {
            if (message && message.textContent) setMessage('', '');
        });

        form.addEventListener('submit', function (e) {
            e.preventDefault();

            var value = input.value.trim();
            if (!isValidEmail(value)) {
                setMessage(invalidText, 'error');
                return;
            }

            setMessage(loadingText, '');
            setLoading(true);

            fetch(ENDPOINT, {
                method: 'POST',
                body: new FormData(form)
            }).then(function () {
                form.reset();
                form.style.transition = 'opacity 320ms cubic-bezier(0.22, 1, 0.36, 1)';
                form.style.opacity = '0';
                window.setTimeout(function () {
                    form.style.display = 'none';
                    setMessage(successText, 'success');
                }, 320);
            }).catch(function (err) {
                console.error('Waitlist error:', err);
                setLoading(false);
                setMessage(errorText, 'error');
            });
        });
    });
})();
