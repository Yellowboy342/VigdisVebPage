document.addEventListener("DOMContentLoaded", function () {
    const waitlistForm = document.getElementById('waitlist-form');
    const waitlistMessage = document.getElementById('waitlist-message');
    const scriptURL = 'https://script.google.com/macros/s/AKfycby7QJGhYzRyj49U0kfYF3QVj71YYPKNhO4YrWNSJEvot77rzVIwAFIQ7nMmTrUkFUDF7A/exec';

    if (waitlistForm) {
        waitlistForm.addEventListener('submit', e => {
            e.preventDefault();
            
            const submitBtn = waitlistForm.querySelector('button');
            const originalBtnText = submitBtn.innerText;
            
            // Get localized messages from data attributes or defaults
            const loadingText = waitlistForm.getAttribute('data-loading') || 'Joining...';
            const successText = waitlistForm.getAttribute('data-success') || 'Success! You have been added to the waitlist.';
            const errorText = waitlistForm.getAttribute('data-error') || 'Error! Something went wrong. Please try again.';

            // UI Feedback: Loading
            submitBtn.innerText = loadingText;
            submitBtn.disabled = true;
            waitlistMessage.innerText = '';
            waitlistMessage.className = 'waitlist-message';

            fetch(scriptURL, { 
                method: 'POST', 
                body: new FormData(waitlistForm)
            })
            .then(response => {
                submitBtn.innerText = originalBtnText;
                submitBtn.disabled = false;
                
                waitlistMessage.innerText = successText;
                waitlistMessage.classList.add('success');
                waitlistForm.reset();
            })
            .catch(error => {
                submitBtn.innerText = originalBtnText;
                submitBtn.disabled = false;
                
                waitlistMessage.innerText = errorText;
                waitlistMessage.classList.add('error');
                console.error('Waitlist Error:', error);
            });
        });
    }
});
