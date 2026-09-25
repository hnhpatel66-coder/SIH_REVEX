/* ============================================================================
   Destructive-action confirmation.
   Shared by the admin portal (vehicles + users) and the owner portal so a
   permanent delete always looks and behaves the same.

   The dialog is deliberately explicit: permanent deletes remove the record AND
   everything that depends on it, so the impact is listed before the user can
   confirm, and the reason is mandatory for the audit trail.
   ========================================================================== */
(function (global) {
  'use strict';

  var active = null;

  function ensureModal() {
    var modal = document.getElementById('confirmDeleteModal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.className = 'modal confirm-modal';
    modal.id = 'confirmDeleteModal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML =
      '<div class="modal-box confirm-card">' +
        '<div class="modal-icon modal-icon-danger">!</div>' +
        '<h2 id="confirmDeleteTitle">Delete permanently</h2>' +
        '<p id="confirmDeleteLead">This cannot be undone.</p>' +
        '<ul class="impact-list" id="confirmDeleteImpact"></ul>' +
        '<div class="danger-note" id="confirmDeleteWarning"></div>' +
        '<div class="field" id="confirmDeleteReasonField">' +
          '<label for="confirmDeleteReason">Reason (required)</label>' +
          '<input id="confirmDeleteReason" maxlength="200" placeholder="Briefly explain why">' +
        '</div>' +
        '<div class="modal-actions">' +
          '<button class="btn btn-danger" id="confirmDeleteYes" type="button">Delete permanently</button>' +
          '<button class="btn btn-outline" id="confirmDeleteNo" type="button">Cancel</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    return modal;
  }

  /**
   * options: { title, lead, impact: [string], warning, confirmLabel, requireReason, onConfirm(reason) }
   */
  function ask(options) {
    var opts = options || {};
    return new Promise(function (resolve) {
      var modal = ensureModal();
      var impact = document.getElementById('confirmDeleteImpact');
      var warning = document.getElementById('confirmDeleteWarning');
      var reasonField = document.getElementById('confirmDeleteReasonField');
      var reasonInput = document.getElementById('confirmDeleteReason');
      var yes = document.getElementById('confirmDeleteYes');
      var no = document.getElementById('confirmDeleteNo');

      document.getElementById('confirmDeleteTitle').textContent = opts.title || 'Delete permanently';
      document.getElementById('confirmDeleteLead').textContent = opts.lead || 'This action cannot be undone.';
      yes.textContent = opts.confirmLabel || 'Delete permanently';

      impact.innerHTML = (opts.impact && opts.impact.length)
        ? opts.impact.map(function (item) { return '<li>' + escapeHtml(item) + '</li>'; }).join('')
        : '';
      impact.style.display = impact.innerHTML ? '' : 'none';

      warning.textContent = opts.warning || 'The record and everything connected to it will be removed from the database. This cannot be undone.';
      reasonField.style.display = opts.requireReason === false ? 'none' : '';
      reasonInput.value = '';

      var requireReason = opts.requireReason !== false;
      function validate() {
        if (requireReason && !reasonInput.value.trim()) {
          reasonInput.focus();
          reasonInput.style.borderColor = 'var(--danger)';
          return false;
        }
        return true;
      }

      function close(result) {
        modal.classList.remove('show');
        document.removeEventListener('keydown', onKey);
        active = null;
        resolve(result);
      }
      function onKey(event) { if (event.key === 'Escape') close(null); }

      yes.onclick = async function () {
        if (!validate()) return;
        const reason = reasonInput.value.trim();
        yes.disabled = true;
        const originalLabel = yes.textContent;
        yes.textContent = 'Deleting…';
        try {
          const result = await opts.onConfirm(reason);
          close(result === undefined ? true : result);
        } catch (error) {
          yes.disabled = false;
          yes.textContent = originalLabel;
          if (global.RevexToast) global.RevexToast(error.message, true);
          else alert(error.message);
          close(false);
        }
      };
      no.onclick = function () { close(null); };
      modal.onclick = function (event) { if (event.target === modal) close(null); };
      document.addEventListener('keydown', onKey);

      document.body.classList.add('modal-open');
      modal.classList.add('show');
      setTimeout(function () { reasonInput.focus(); }, 60);
      active = modal;
    });
  }

  global.confirmDelete = ask;
})(window);
