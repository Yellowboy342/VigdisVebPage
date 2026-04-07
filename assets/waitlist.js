document.addEventListener("DOMContentLoaded", function () {
    const scriptURL = 'https://script.google.com/macros/s/AKfycbwRnbN7F1WMgHIGQ8ebJw2Zpl3q_CcobxSlAYqwcDuX9PSQr5Y-Yha5xGFOHdAgyoeimA/exec';

    // Basic email regex for client side validation
    const validateEmail = (email) => {
        return String(email)
            .toLowerCase()
            .match(
                /^(([^<>()[\]\\.,;:\s@"]+(\.?[^<>()[\]\\.,;:\s@"]+)*)|.(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/
            );
    };

    // Mini confetti burst (pure JS, no libraries)
    function spawnConfetti(container) {
        const colors = ['#E88A8A', '#F0A0A0', '#D87070', '#FEF5F0', '#FFB800', '#2D6A4F'];
        const confettiCount = 30;
        for (let i = 0; i < confettiCount; i++) {
            const confetti = document.createElement('div');
            confetti.className = 'confetti-piece';
            confetti.style.cssText = `
                position: absolute;
                width: ${Math.random() * 8 + 4}px;
                height: ${Math.random() * 8 + 4}px;
                background: ${colors[Math.floor(Math.random() * colors.length)]};
                border-radius: ${Math.random() > 0.5 ? '50%' : '2px'};
                left: 50%;
                top: 50%;
                pointer-events: none;
                z-index: 10;
                animation: confettiFall ${Math.random() * 1.5 + 1}s cubic-bezier(.25,.46,.45,.94) forwards;
                --confetti-x: ${(Math.random() - 0.5) * 300}px;
                --confetti-y: ${Math.random() * -200 - 50}px;
                --confetti-r: ${Math.random() * 720 - 360}deg;
            `;
            container.appendChild(confetti);
            setTimeout(() => confetti.remove(), 2500);
        }
    }

    const waitlistForms = document.querySelectorAll('.waitlist-form, .waitlist-form-cta');

    waitlistForms.forEach(waitlistForm => {
        const emailInput = waitlistForm.querySelector('input[type="email"]');
        const submitBtn = waitlistForm.querySelector('button');
        const waitlistMessage = waitlistForm.nextElementSibling;

        // Initial state: Disable the button to start
        submitBtn.disabled = true;

        // Real-time evaluation of valid state
        emailInput.addEventListener('input', () => {
            waitlistForm.classList.remove('invalid');
            waitlistMessage.classList.remove('show');

            const emailValue = emailInput.value.trim();
            submitBtn.disabled = !validateEmail(emailValue);
        });

        waitlistForm.addEventListener('submit', e => {
            e.preventDefault();

            const originalBtnText = submitBtn.innerText;
            const emailValue = emailInput.value.trim();

            // Get localized messages
            const loadingText = waitlistForm.getAttribute('data-loading') || 'Subscribing...';
            const successText = waitlistForm.getAttribute('data-success') || 'Success! You are now subscribed.';
            const errorText = waitlistForm.getAttribute('data-error') || 'Error! Something went wrong. Please try again.';

            const invalidEmailText = document.documentElement.lang.startsWith('is')
                ? 'Vinsamlegast sláðu inn gilt netfang.'
                : 'Please enter a valid email address.';

            if (!validateEmail(emailValue)) {
                waitlistForm.classList.add('invalid');
                waitlistMessage.innerText = invalidEmailText;
                waitlistMessage.className = 'waitlist-message error show';
                setTimeout(() => {
                    waitlistForm.classList.remove('invalid');
                }, 400);
                return;
            }

            // UI Feedback: Loading state with spinner
            submitBtn.innerHTML = `<span class="btn-spinner"></span>`;
            submitBtn.disabled = true;
            waitlistMessage.className = 'waitlist-message';

            fetch(scriptURL, {
                method: 'POST',
                body: new FormData(waitlistForm)
            })
                .then(response => {
                    // SUCCESS: Replace the form with an animated success state
                    const parentContainer = waitlistForm.parentElement;
                    parentContainer.style.position = 'relative';

                    waitlistForm.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
                    waitlistForm.style.opacity = '0';
                    waitlistForm.style.transform = 'scale(0.95)';

                    setTimeout(() => {
                        waitlistForm.style.display = 'none';

                        // Build success UI
                        const successEl = document.createElement('div');
                        successEl.className = 'waitlist-success-state';
                        successEl.innerHTML = `
                            <svg class="checkmark-svg" viewBox="0 0 52 52">
                                <circle class="checkmark-circle" cx="26" cy="26" r="25" fill="none"/>
                                <path class="checkmark-check" fill="none" d="M14.1 27.2l7.1 7.2 16.7-16.8"/>
                            </svg>
                            <p class="success-heading">${successText}</p>
                        `;

                        // Hide the old message
                        waitlistMessage.style.display = 'none';

                        parentContainer.appendChild(successEl);

                        // Trigger animation
                        requestAnimationFrame(() => {
                            successEl.classList.add('active');
                            spawnConfetti(parentContainer);
                        });
                    }, 300);

                    waitlistForm.reset();
                })
                .catch(error => {
                    submitBtn.innerText = originalBtnText;
                    submitBtn.disabled = false;

                    waitlistMessage.innerHTML = `<span class="error-icon">⚠️</span> ${errorText}`;
                    waitlistMessage.className = 'waitlist-message error show';
                    console.error('Waitlist Error:', error);
                });
        });
    });
});
