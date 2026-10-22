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
      // A file over the size limit is refused here, before a long upload the server would refuse.
      const tooBig = files.find((file) => file.size > Number(form.dataset.maxBytes));
      if (tooBig) return showError(form.dataset.errorSize.replace('{name}', tooBig.name));
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
// The three-pane board: the client milestone page, and its example on the home page
// ---------------------------------------------------------------------------
function bindBoard(board, onChange = () => {}) {
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
    onChange(board.dataset.focus);
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

  return { setFocus, reveal, slides };
}

// ---------------------------------------------------------------------------
// Client milestone page
// ---------------------------------------------------------------------------
const review = document.querySelector('[data-review]');
if (review) {
  const { reveal, slides } = bindBoard(review.querySelector('.board'));

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

// ---------------------------------------------------------------------------
// Home page: the example of the client page opens its panes one by one,
// until the visitor touches it. Then it stays as they leave it.
// ---------------------------------------------------------------------------
const demo = document.querySelector('[data-demo]');
if (demo) {
  const pills = [...demo.querySelectorAll('[data-demo-pick]')];
  const caption = demo.querySelector('[data-demo-caption]');
  const board = demo.querySelector('.board');

  const { setFocus } = bindBoard(board, (focus) => {
    pills.forEach((pill) => pill.setAttribute('aria-pressed', String(pill.dataset.demoPick === focus)));
    const key = { files: 'captionFiles', desc: 'captionDesc', amount: 'captionAmount' }[focus] || 'captionAll';
    if (caption.textContent !== caption.dataset[key]) caption.textContent = caption.dataset[key];
  });

  let timer = null;
  let visible = false;
  const stop = () => {
    clearInterval(timer);
    timer = null;
    demo.removeEventListener('pointerdown', stop, true);
    demo.removeEventListener('keydown', stop, true);
    observer?.disconnect();
  };

  pills.forEach((pill) =>
    pill.addEventListener('click', () => setFocus(board.dataset.focus === pill.dataset.demoPick ? '' : pill.dataset.demoPick)),
  );

  // Turns run only while the example is on screen, and never for visitors who asked for less motion.
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)');
  const observer = calm.matches || !('IntersectionObserver' in window) ? null : new IntersectionObserver((entries) => {
    visible = entries[0].isIntersecting;
    if (visible && !timer) {
      timer = setInterval(() => {
        if (!visible || document.hidden) return;
        const order = wide.matches ? ['files', 'desc', 'amount', ''] : ['files', 'desc', 'amount'];
        const next = order[(order.indexOf(board.dataset.focus) + 1) % order.length];
        setFocus(next);
      }, 4000);
    }
  }, { threshold: 0.5 });
  if (observer) {
    observer.observe(board);
    demo.addEventListener('pointerdown', stop, true);
    demo.addEventListener('keydown', stop, true);
  }
}

// ---------------------------------------------------------------------------
// Confirmation dialogs: <a href="/projects/1/complete" data-modal>.
// The link is a page of its own; here its form opens over the current page instead.
// ---------------------------------------------------------------------------
document.addEventListener('click', async (event) => {
  const link = event.target.closest('a[data-modal]');
  if (!link || typeof HTMLDialogElement !== 'function' || event.metaKey || event.ctrlKey || event.shiftKey) return;
  event.preventDefault();

  let content = null;
  try {
    const response = await fetch(link.href, { credentials: 'same-origin' });
    if (response.ok) {
      const page = new DOMParser().parseFromString(await response.text(), 'text/html');
      content = page.querySelector('[data-modal-content]');
    }
  } catch {}
  if (!content) return (window.location.href = link.href);

  const dialog = document.createElement('dialog');
  dialog.className = 'modal';
  const title = content.querySelector('h1');
  if (title) {
    title.id = 'modal-title';
    dialog.setAttribute('aria-labelledby', 'modal-title');
  }
  dialog.append(document.importNode(content, true));
  dialog.querySelectorAll('[data-modal-close]').forEach((close) =>
    close.addEventListener('click', (closeEvent) => {
      closeEvent.preventDefault();
      dialog.close();
    }),
  );
  // A click on the dimmed backdrop closes the dialog; Escape does too, natively.
  dialog.addEventListener('click', (clickEvent) => {
    if (clickEvent.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    link.focus();
  });
  document.body.append(dialog);
  dialog.showModal();
  dialog.querySelector('input, textarea, select, button')?.focus();
});

// ---------------------------------------------------------------------------
// Private notes on a project: the tab slides the panel up, and the text is saved
// a moment after the developer stops typing, and when they leave the page.
// ---------------------------------------------------------------------------
const notes = document.querySelector('[data-notes]');
if (notes) {
  const toggle = notes.querySelector('[data-notes-toggle]');
  const form = notes.querySelector('[data-notes-form]');
  const area = form.querySelector('textarea');
  const status = notes.querySelector('[data-notes-status]');
  const count = notes.querySelector('[data-notes-count]');
  let timer = null;
  let dirty = false;

  const setOpen = (open) => {
    notes.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    if (open) area.focus({ preventScroll: true });
    else if (notes.contains(document.activeElement)) toggle.focus();
  };

  toggle.addEventListener('click', () => setOpen(!notes.classList.contains('is-open')));
  notes.querySelector('[data-notes-close]').addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && notes.classList.contains('is-open') && !document.querySelector('dialog[open]')) setOpen(false);
  });
  document.addEventListener('pointerdown', (event) => {
    if (notes.classList.contains('is-open') && !notes.contains(event.target)) setOpen(false);
  });
  if (window.location.hash === '#notes') setOpen(true);

  const formData = () => new URLSearchParams(new FormData(form));

  const save = async () => {
    clearTimeout(timer);
    if (!dirty) return;
    dirty = false;
    status.textContent = status.dataset.saving;
    try {
      const response = await fetch(form.action, {
        method: 'POST',
        body: formData(),
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error(String(response.status));
      status.textContent = status.dataset.saved;
    } catch {
      dirty = true;
      status.textContent = status.dataset.error;
    }
  };

  area.addEventListener('input', () => {
    dirty = true;
    count.textContent = count.dataset.template.replace('{count}', area.value.length);
    clearTimeout(timer);
    timer = setTimeout(save, 800);
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    dirty = true;
    save();
  });
  window.addEventListener('pagehide', () => {
    if (dirty && navigator.sendBeacon) navigator.sendBeacon(form.action, formData());
  });
}

// ---------------------------------------------------------------------------
// A form in short steps: <form data-steps> with <fieldset data-step="0">…
// Without JavaScript every step is shown at once.
// ---------------------------------------------------------------------------
document.querySelectorAll('form[data-steps]').forEach((form) => {
  const steps = [...form.querySelectorAll('[data-step]')];
  const dots = [...form.querySelectorAll('[data-step-dot]')];
  const back = form.querySelector('[data-step-back]');
  const next = form.querySelector('[data-step-next]');
  const submit = form.querySelector('[data-step-submit]');
  let current = 0;

  const show = (index, focus = true) => {
    current = index;
    steps.forEach((step, i) => step.classList.toggle('is-current', i === index));
    dots.forEach((dot, i) => {
      dot.classList.toggle('is-current', i === index);
      dot.classList.toggle('is-done', i < index);
    });
    back.hidden = index === 0;
    next.hidden = index === steps.length - 1;
    submit.hidden = index !== steps.length - 1;
    if (focus) steps[index].querySelector('input, textarea, select')?.focus();
  };

  const valid = (step) => [...step.querySelectorAll('input, textarea, select')].every((field) => field.reportValidity());

  next.addEventListener('click', () => {
    if (valid(steps[current])) show(current + 1);
  });
  back.addEventListener('click', () => show(current - 1));
  // Enter in a field moves on to the next step rather than sending the form early.
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.tagName === 'INPUT' && current < steps.length - 1) {
      event.preventDefault();
      next.click();
    }
  });
  // After an error from the server, open the first step with a field to fix.
  const firstInvalid = steps.findIndex((step) => [...step.querySelectorAll('input, textarea, select')].some((field) => !field.checkValidity()));
  show(firstInvalid === -1 ? 0 : firstInvalid, firstInvalid !== -1);
});

// ---------------------------------------------------------------------------
// Home charts: the pills switch the chart in place. Without JavaScript each pill
// is a link that reloads the page with ?chart=.
// ---------------------------------------------------------------------------
document.querySelectorAll('[data-charts]').forEach((root) => {
  const picks = [...root.querySelectorAll('[data-chart-pick]')];
  const panels = [...root.querySelectorAll('[data-chart-panel]')];
  picks.forEach((pick) => {
    pick.addEventListener('click', (event) => {
      event.preventDefault();
      const name = pick.dataset.chartPick;
      picks.forEach((p) => (p === pick ? p.setAttribute('aria-current', 'true') : p.removeAttribute('aria-current')));
      panels.forEach((panel) => (panel.hidden = panel.dataset.chartPanel !== name));
      const url = new URL(window.location.href);
      url.searchParams.set('chart', name);
      history.replaceState(null, '', url.pathname + url.search);
    });
  });
});

// ---------------------------------------------------------------------------
// A field shown only for one answer: <div data-show-when="activity=other">.
// Without JavaScript it is always shown.
// ---------------------------------------------------------------------------
document.querySelectorAll('[data-show-when]').forEach((block) => {
  const [name, value] = block.dataset.showWhen.split('=');
  const form = block.closest('form');
  const update = () => {
    block.hidden = form.querySelector(`input[name="${name}"]:checked`)?.value !== value;
  };
  form.querySelectorAll(`input[name="${name}"]`).forEach((input) => input.addEventListener('change', update));
  update();
});

// On a phone the tab row scrolls sideways: keep the current tab in view.
document.querySelector('.app-tabs [aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
