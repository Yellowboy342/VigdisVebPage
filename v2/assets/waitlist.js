/**
 * Vigdís v2 — minimal waitlist handler.
 *
 * Replaces the original confetti + scale animation with a quiet,
 * paper-and-ink success state in keeping with the Japandi visual
 * language: the form fades, a single line of serif italic copy
 * takes its place, and that's it.
 *
 * Same Google Apps Script endpoint, same data attributes
 * (`data-loading`, `data-success`, `data-error`), so existing
 * server-side handling is unchanged.
 */

(function () {
    'use strict';

    var ENDPOINT = 'https://script.google.com/macros/s/AKfycbwRnbN7F1WMgHIGQ8ebJw2Zpl3q_CcobxSlAYqwcDuX9PSQr5Y-Yha5xGFOHdAgyoeimA/exec';

    var EMAIL_REGEX = /^(([^<>()[\]\\.,;:\s@"]+(\.?[^<>()[\]\\.,;:\s@"]+)*)|.(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;

    function isValidEmail(value) {
        return EMAIL_REGEX.test(String(value).toLowerCase());
    }

    document.addEventListener('DOMContentLoaded', function () {
        var form = document.getElementById('waitlist-form-cta');
        if (!form) return;

        var input = form.querySelector('input[type="email"]');
        var submit = form.querySelector('button[type="submit"]');
        var message = document.getElementById('waitlist-message-cta');
        if (!input || !submit) return;

        var loadingText = form.getAttribute('data-loading') || 'Subscribing...';
        var successText = form.getAttribute('data-success') || 'Thanks! You are now subscribed.';
        var errorText = form.getAttribute('data-error') || 'Error! Something went wrong. Please try again.';

        var invalidText = document.documentElement.lang.indexOf('is') === 0
            ? 'Vinsamlegast sláðu inn gilt netfang.'
            : 'Please enter a valid email address.';

        var setMessage = function (text, tone) {
            if (!message) return;
            message.textContent = text || '';
            message.style.color = tone === 'error'
                ? '#9A2B2B'
                : tone === 'success'
                    ? '#1B1916'
                    : '#8A857D';
            message.style.fontStyle = tone === 'success' ? 'italic' : 'normal';
            message.style.fontFamily = tone === 'success'
                ? '"Cormorant Garamond", Georgia, serif'
                : 'inherit';
            message.style.fontSize = tone === 'success' ? '17px' : '13px';
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
                // Replace the form row with the serif italic
                // success line. Single sentence, no animation
                // beyond a fade — the form's parent container
                // owns its own opacity transition.
                form.reset();
                form.style.transition = 'opacity 320ms ease';
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
