// Signoff browser script. Every page works without it; it adds the interactions on top.
document.documentElement.classList.add('js');

const wide = window.matchMedia('(min-width: 1100px)');

// Copy-to-clipboard buttons: <button data-copy="#input-id" data-copied-label="Copied">
document.querySelectorAll('[data-copy]').forEach((button) => {
  button.addEventListener('click', async () => {
    const input = document.querySelector(button.dataset.copy);
    const original = button.innerHTML;
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select();
      document.execCommand('copy');
    }
    button.textContent = button.dataset.copiedLabel;
    setTimeout(() => (button.innerHTML = original), 1500);
  });
});

// Forms that ask for confirmation: <form data-confirm="Are you sure?">
function bindConfirm(root) {
  root.querySelectorAll('form[data-confirm]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      if (!window.confirm(form.dataset.confirm)) event.preventDefault();
    });
  });
}
bindConfirm(document);

// Buttons that show a spinner once their form is on its way: <button data-loading>
document.addEventListener('submit', (event) => {
  if (event.defaultPrevented) return;
  const button = event.submitter;
  if (button && button.hasAttribute('data-loading')) {
    button.classList.add('is-loading');
    button.setAttribute('aria-busy', 'true');
  }
});
// Coming back with the browser's back button shows the page as it was: remove the spinners.
window.addEventListener('pageshow', () => {
  document.querySelectorAll('.is-loading').forEach((button) => {
    button.classList.remove('is-loading');
    button.removeAttribute('aria-busy');
  });
});

document.querySelectorAll('[data-print]').forEach((button) => {
  button.addEventListener('click', () => window.print());
});

// After an upload or a deletion, only the files section is reloaded,
// so whatever is being typed elsewhere on the page stays as it is.
async function refreshFiles(region) {
  const response = await fetch(window.location.href, { credentials: 'same-origin' });
  const html = await response.text();
  const fresh = new DOMParser().parseFromString(html, 'text/html').querySelector('[data-files-region]');
  if (!fresh) return window.location.reload();
  region.replaceWith(fresh);
  bindFiles(fresh);
}

function bindFiles(region) {
  bindConfirm(region);
  bindLightbox(region);

  region.querySelectorAll('form[action$="/delete"]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      await fetch(form.action, { method: 'POST', body: new URLSearchParams(new FormData(form)), credentials: 'same-origin' });
      refreshFiles(region);
    });
  });

  // File drop zone: drag and drop or "Choose files", uploaded with a progress bar.
  region.querySelectorAll('form[data-upload]').forEach((form) => {
    const input = form.querySelector('input[type="file"]');
    const progress = form.querySelector('progress');
    const error = form.querySelector('.upload-error');

    const showError = (message) => {
      error.textContent = message;
      error.hidden = false;
    };

    const done = () => {
      progress.hidden = true;
      form.classList.remove('is-uploading');
      form.removeAttribute('aria-busy');
      input.value = '';
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
        if (request.status >= 200 && request.status < 300) return refreshFiles(region);
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
}

// Image thumbnails open larger in a dialog; without JavaScript they open in a new tab.
function bindLightbox(root) {
  root.querySelectorAll('a[data-lightbox]').forEach((link) => {
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
}

const filesRegion = document.querySelector('[data-files-region]');
if (filesRegion) bindFiles(filesRegion);
else bindLightbox(document);

// ---------------------------------------------------------------------------
// Client milestone page
// ---------------------------------------------------------------------------
const review = document.querySelector('[data-review]');
if (review) {
  const board = review.querySelector('.board');

  // Panes: on a wide screen one pane can be expanded while the others shrink into bands;
  // on a phone they fold open one at a time (title and description open by default).
  const openPane = () => board.dataset.focus || (wide.matches ? '' : 'desc');

  const syncPanes = () => {
    board.querySelectorAll('[data-pane-toggle]').forEach((button) => {
      const name = button.dataset.paneToggle;
      const expanded = wide.matches ? board.dataset.focus === name : openPane() === name;
      button.setAttribute('aria-expanded', String(expanded));
      button.setAttribute('aria-label', expanded ? button.dataset.labelCollapse : button.dataset.labelExpand);
    });
  };

  const setFocus = (name) => {
    board.dataset.focus = name;
    syncPanes();
  };

  board.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-pane-toggle]');
    if (toggle) {
      const name = toggle.dataset.paneToggle;
      if (wide.matches) setFocus(board.dataset.focus === name ? '' : name);
      else setFocus(openPane() === name ? 'none' : name);
      return;
    }
    const band = event.target.closest('[data-pane-open]');
    if (band) {
      setFocus(band.dataset.paneOpen);
      board.querySelector(`[data-pane-toggle="${band.dataset.paneOpen}"]`)?.focus({ preventScroll: true });
    }
  });

  wide.addEventListener('change', () => {
    if (board.dataset.focus === 'none') board.dataset.focus = '';
    syncPanes();
  });
  syncPanes();

  // File viewer: previous / next, counter "2/4", and the square bubbles.
  const slides = [...board.querySelectorAll('[data-slide]')];
  let current = 0;
  const show = (index) => {
    if (slides.length === 0) return;
    current = (index + slides.length) % slides.length;
    slides.forEach((slide, i) => (slide.hidden = i !== current));
    const label = `${current + 1}/${slides.length}`;
    board.querySelectorAll('[data-viewer-counter], [data-viewer-counter-copy]').forEach((el) => (el.textContent = label));
    board.querySelectorAll('.thumbs [data-viewer-go]').forEach((button, i) => button.setAttribute('aria-current', String(i === current)));
  };
  board.querySelector('[data-viewer-prev]')?.addEventListener('click', () => show(current - 1));
  board.querySelector('[data-viewer-next]')?.addEventListener('click', () => show(current + 1));
  board.querySelectorAll('.thumbs [data-viewer-go]').forEach((button) =>
    button.addEventListener('click', () => show(Number(button.dataset.viewerGo))),
  );
  board.querySelector('[data-viewer]')?.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') show(current - 1);
    if (event.key === 'ArrowRight') show(current + 1);
  });

  // Opens a file in the viewer from elsewhere, making sure the files pane is visible.
  const reveal = (index) => {
    show(index);
    const open = openPane();
    if (open !== 'files' && open !== '') setFocus(wide.matches ? '' : 'files');
  };

  // Decision panel: choose → approve (name + "I confirm") or feedback.
  const decision = review.querySelector('[data-decision]');
  if (decision) {
    const setMode = (mode) => {
      decision.dataset.mode = mode;
      // On a phone the bottom bar steps aside while the client types.
      document.body.classList.toggle('decision-open', mode !== 'choose');
      if (mode !== 'feedback') review.classList.remove('is-wide');
      const target = mode === 'approve' ? '#approve-name' : mode === 'feedback' ? '#message' : '[data-mode-set="approve"]';
      decision.querySelector(target)?.focus({ preventScroll: wide.matches });
    };

    document.querySelectorAll('[data-mode-set]').forEach((trigger) =>
      trigger.addEventListener('click', (event) => {
        event.preventDefault();
        setMode(trigger.dataset.modeSet);
        if (!wide.matches) decision.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }),
    );
    if (decision.dataset.mode !== 'choose') document.body.classList.add('decision-open');
    decision.querySelectorAll('[data-mode-back]').forEach((button) => button.addEventListener('click', () => setMode('choose')));

    // The feedback area can widen, taking room from the board while the files stay visible.
    const widen = decision.querySelector('[data-widen]');
    widen?.addEventListener('click', () => {
      const on = review.classList.toggle('is-wide');
      widen.setAttribute('aria-pressed', String(on));
      widen.setAttribute('aria-label', on ? widen.dataset.labelNarrow : widen.dataset.labelWiden);
    });

    // File pills insert "/fichier2" where the cursor is, and show that file.
    const message = decision.querySelector('#message');
    decision.querySelectorAll('[data-cite]').forEach((pill) =>
      pill.addEventListener('click', () => {
        const tag = pill.dataset.cite;
        const start = message.selectionStart ?? message.value.length;
        const end = message.selectionEnd ?? start;
        const before = message.value.slice(0, start);
        const after = message.value.slice(end);
        const text = `${before && !/\s$/.test(before) ? ' ' : ''}${tag} `;
        message.value = before + text + after;
        const caret = before.length + text.length;
        message.focus({ preventScroll: true });
        message.setSelectionRange(caret, caret);
        reveal(Number(pill.dataset.viewerGo));
      }),
    );

    // Typing "/fichier3" by hand also shows that file.
    message?.addEventListener('input', () => {
      const typed = message.value.slice(0, message.selectionStart).match(/\/(?:fichier|file)(\d{1,3})$/i);
      if (typed && slides[Number(typed[1]) - 1]) reveal(Number(typed[1]) - 1);
    });
  }
}
