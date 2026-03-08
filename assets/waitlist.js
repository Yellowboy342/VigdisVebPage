document.addEventListener("DOMContentLoaded", function () {
    const waitlistForm = document.getElementById('waitlist-form');
    const waitlistMessage = document.getElementById('waitlist-message');
    const scriptURL = 'https://script.google.com/macros/s/AKfycby7QJGhYzRyj49U0kfYF3QVj71YYPKNhO4YrWNSJEvot77rzVIwAFIQ7nMmTrUkFUDF7A/exec';

    // Basic email regex for client side validation
    const validateEmail = (email) => {
        return String(email)
            .toLowerCase()
            .match(
                /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|.(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/
            );
    };

    const waitlistForms = document.querySelectorAll('.waitlist-form, .waitlist-form-cta');

    waitlistForms.forEach(waitlistForm => {
        const emailInput = waitlistForm.querySelector('input[type="email"]');
        const submitBtn = waitlistForm.querySelector('button');
        const waitlistMessage = waitlistForm.nextElementSibling; // div.waitlist-message or ...-cta

        // Initial state: Disable the button to start
        submitBtn.disabled = true;

        // Real-time evaluation of valid state
        emailInput.addEventListener('input', () => {
            waitlistForm.classList.remove('invalid');
            waitlistMessage.classList.remove('show');

            // Enable button if valid, disable if invalid
            const emailValue = emailInput.value.trim();
            submitBtn.disabled = !validateEmail(emailValue);
        });

        waitlistForm.addEventListener('submit', e => {
            e.preventDefault();

            const originalBtnText = submitBtn.innerText;
            const emailValue = emailInput.value.trim();

            // Get localized messages
            const loadingText = waitlistForm.getAttribute('data-loading') || 'Joining...';
            const successText = waitlistForm.getAttribute('data-success') || 'Success! You have been added to the waitlist.';
            const errorText = waitlistForm.getAttribute('data-error') || 'Error! Something went wrong. Please try again.';

            // Waitlist specific language detection for invalid email message
            const invalidEmailText = document.documentElement.lang.startsWith('is')
                ? 'Vinsamlegast sláðu inn gilt netfang.'
                : 'Please enter a valid email address.';

            if (!validateEmail(emailValue)) {
                waitlistForm.classList.add('invalid');
                waitlistMessage.innerText = invalidEmailText;
                waitlistMessage.className = 'waitlist-message error show';

                // Remove the shake class after animation completes so it can trigger again
                setTimeout(() => {
                    waitlistForm.classList.remove('invalid');
                }, 400);
                return;
            }

            // UI Feedback: Loading
            submitBtn.innerText = loadingText;
            submitBtn.disabled = true;
            waitlistMessage.className = 'waitlist-message';

            fetch(scriptURL, {
                method: 'POST',
                body: new FormData(waitlistForm)
            })
                .then(response => {
                    submitBtn.innerText = originalBtnText;
                    submitBtn.disabled = false;

                    waitlistMessage.innerText = successText;
                    waitlistMessage.className = 'waitlist-message success show';
                    waitlistForm.reset();
                })
                .catch(error => {
                    submitBtn.innerText = originalBtnText;
                    submitBtn.disabled = false;

                    waitlistMessage.innerText = errorText;
                    waitlistMessage.className = 'waitlist-message error show';
                    console.error('Waitlist Error:', error);
                });
        });
    });
});
