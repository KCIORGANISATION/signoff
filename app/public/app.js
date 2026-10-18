// Copy-to-clipboard buttons: <button data-copy="#input-id" data-copied-label="Copied">
document.querySelectorAll('[data-copy]').forEach((button) => {
  button.addEventListener('click', async () => {
    const input = document.querySelector(button.dataset.copy);
    const original = button.textContent;
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select();
      document.execCommand('copy');
    }
    button.textContent = button.dataset.copiedLabel;
    setTimeout(() => (button.textContent = original), 1500);
  });
});

// Forms that ask for confirmation: <form data-confirm="Are you sure?">
document.querySelectorAll('form[data-confirm]').forEach((form) => {
  form.addEventListener('submit', (event) => {
    if (!window.confirm(form.dataset.confirm)) event.preventDefault();
  });
});

document.querySelectorAll('[data-print]').forEach((button) => {
  button.addEventListener('click', () => window.print());
});
