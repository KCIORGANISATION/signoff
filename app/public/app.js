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

// File drop zone: drag and drop or "Choose files", uploaded with a progress bar.
document.querySelectorAll('form[data-upload]').forEach((form) => {
  const input = form.querySelector('input[type="file"]');
  const progress = form.querySelector('progress');
  const error = form.querySelector('.upload-error');

  const showError = (message) => {
    error.textContent = message;
    error.hidden = false;
  };

  const upload = (files) => {
    if (files.length === 0 || form.classList.contains('is-uploading')) return;
    const data = new FormData();
    data.append('_csrf', form.querySelector('input[name="_csrf"]').value);
    for (const file of files) data.append('files', file);

    const request = new XMLHttpRequest();
    request.open('POST', form.action);
    request.setRequestHeader('Accept', 'application/json');
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) progress.value = Math.round((event.loaded / event.total) * 100);
    });
    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) return window.location.reload();
      let message = form.dataset.errorGeneric;
      try {
        message = JSON.parse(request.responseText).error || message;
      } catch {}
      done();
      showError(message);
    });
    request.addEventListener('error', () => {
      done();
      showError(form.dataset.errorGeneric);
    });

    error.hidden = true;
    progress.value = 0;
    progress.hidden = false;
    form.classList.add('is-uploading');
    form.setAttribute('aria-busy', 'true');
    request.send(data);
  };

  const done = () => {
    progress.hidden = true;
    form.classList.remove('is-uploading');
    form.removeAttribute('aria-busy');
    input.value = '';
  };

  input.addEventListener('change', () => upload([...input.files]));
  form.addEventListener('dragover', (event) => {
    event.preventDefault();
    form.classList.add('is-dragging');
  });
  form.addEventListener('dragleave', () => form.classList.remove('is-dragging'));
  form.addEventListener('drop', (event) => {
    event.preventDefault();
    form.classList.remove('is-dragging');
    upload([...event.dataTransfer.files]);
  });
});

// Image thumbnails open larger in a dialog; without JavaScript they open in a new tab.
document.querySelectorAll('a[data-lightbox]').forEach((link) => {
  link.addEventListener('click', (event) => {
    if (typeof HTMLDialogElement !== 'function') return;
    event.preventDefault();
    const dialog = document.createElement('dialog');
    dialog.className = 'lightbox';
    dialog.setAttribute('aria-label', link.dataset.caption);
    const image = document.createElement('img');
    image.src = link.href;
    image.alt = link.dataset.caption;
    const caption = document.createElement('p');
    caption.textContent = link.dataset.caption;
    dialog.append(image, caption);
    dialog.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  });
});
