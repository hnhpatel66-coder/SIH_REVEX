/* ============================================================================
 * PROFILE PAGE  (js/profile-page.js)
 *
 * Extracted out of an inline <script> block so it can be syntax-checked, tested
 * and read like the rest of the codebase.
 *
 * 1.3 addition: the profile PHOTO. The admin Users and Owners screens already
 * rendered `user.photo` / `owner.photo`, but the model had no such field, so
 * both lists always showed the fallback placeholder. Owners in particular were
 * indistinguishable from one another. The photo is now a real, validated,
 * account-level field used by the navbar, this page and both admin lists.
 * ========================================================================== */
(function (global) {
  'use strict';

  const R = global.REVEX;
  if (!R) return;

  const { api, escapeHtml, formatMoney, formatDateTime, showToast, showModal, confirmAction, setSession, getToken, getStoredUser, clearSession, imageOrInitials } = R;

  let user = null;
  let removePhotoRequested = false;

  function paintAvatar() {
    const host = document.getElementById('avatarHost');
    if (!host) return;
    host.innerHTML = '';
    host.insertAdjacentHTML('afterbegin', imageOrInitials(user?.photo, user?.name, { className: 'rvx-thumb--empty', alt: '' }));
    const note = document.getElementById('profilePhotoNote');
    if (note) note.textContent = user?.photo ? 'A profile photo is set and shown beside your name everywhere on REVEX.' : 'No profile photo yet. Everything falls back to your initials.';
  }

  function paintDetails() {
    document.getElementById('profileName').textContent = user.name;
    document.getElementById('profileEmail').textContent = user.email;
    document.getElementById('profilePhone').textContent = user.phone || '-';
    document.getElementById('profileRole').textContent = user.role;
    document.getElementById('profileMeta').textContent = user.isVerified ? 'Verified account' : 'Account created';
    document.getElementById('editName').value = user.name || '';
    document.getElementById('editPhone').value = user.phone || '';
    paintAvatar();
  }

  function paintRoleBox() {
    const box = document.getElementById('roleSwitchBox');
    if (!box) return;
    if (user.role === 'admin') {
      box.innerHTML = '<p>You are signed in as an administrator.</p><a class="btn btn-outline" href="admin.html">Open admin dashboard</a>';
      return;
    }
    if (user.role === 'user') {
      box.innerHTML = '<p>Want to list vehicles and offer rides?</p><button class="btn btn-primary" id="becomeOwner" type="button" style="width:100%">Switch to owner account</button>';
      return;
    }
    box.innerHTML = `<p>You are an owner. You can switch back to a renter account.</p>
      <div class="rvx-btnrow">
        <button class="btn btn-outline" id="becomeUser" type="button" style="flex:1 1 auto">Switch to user account</button>
        <a class="btn btn-primary" href="ride-requests.html" style="flex:1 1 auto">Ride requests</a>
      </div>`;
  }

  async function switchRole(newRole, destination) {
    const answer = await confirmAction({
      title: newRole === 'owner' ? 'Switch this account to an owner account?' : 'Switch back to a renter account?',
      message: newRole === 'owner'
        ? 'You will be able to list vehicles, offer rides and review booking requests. An admin still approves each vehicle and each ride offer.'
        : 'Your vehicles and ride offers stay listed, but the owner tools are hidden.',
      confirmLabel: 'Switch role'
    });
    if (!answer) return;
    try {
      const data = await api('/auth/switch-role', { method: 'POST', body: { newRole } });
      setSession(data);
      location.href = destination;
    } catch (error) { showToast(error.message, 'bad', 8000); }
  }

  function readPhoto(file, maxMb = 1.5) {
    return new Promise((resolve, reject) => {
      if (!file) return resolve(null);
      if (file.size > maxMb * 1024 * 1024) return reject(new Error(`The profile photo must be smaller than ${maxMb} MB.`));
      if (!/^image\/(png|jpeg|jpg|webp|gif)$/i.test(file.type)) {
        return reject(new Error('The profile photo must be a PNG, JPEG, WebP or GIF image.'));
      }
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('The selected photo could not be read.'));
      reader.readAsDataURL(file);
    });
  }

  async function saveProfile(event) {
    event.preventDefault();
    const button = event.target.querySelector('button[type="submit"]');
    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<span class="rvx-spinner" aria-hidden="true"></span> Saving…';
    try {
      const body = {
        name: document.getElementById('editName').value.trim(),
        phone: document.getElementById('editPhone').value.trim()
      };
      const file = document.getElementById('editPhoto').files?.[0];
      if (file) body.photo = await readPhoto(file);
      else if (removePhotoRequested) body.removePhoto = true;
      const data = await api('/auth/edit-profile', { method: 'POST', body });
      setSession({ token: getToken(), user: data.user });
      user = { ...user, ...data.user };
      removePhotoRequested = false;
      document.getElementById('editPhoto').value = '';
      paintDetails();
      showModal('Profile updated', data.message || 'Your profile was saved.');
      showToast('Profile saved.', 'ok');
    } catch (error) {
      showToast(error.message, 'bad', 8000);
    } finally {
      button.disabled = false;
      button.innerHTML = original;
    }
  }

  async function loadNotifications() {
    const list = document.getElementById('notificationList');
    if (!list) return;
    try {
      const items = await api('/notifications');
      list.innerHTML = items.length
        ? items.map(item => `<div class="list-row"><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.message)} · ${escapeHtml(formatDateTime(item.createdAt))}</small></div><button class="btn btn-outline btn-small" data-read-notification="${escapeHtml(item.id)}" type="button">${item.read ? 'Read' : 'Mark read'}</button></div>`).join('')
        : '<div class="empty">No notifications yet.</div>';
    } catch (error) {
      list.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    }
  }

  async function loadOwnerFields() {
    const box = document.getElementById('ownerFields');
    if (!box || user.role !== 'owner') return;
    box.style.display = 'block';
    try {
      const summary = await api('/bookings/owner/summary');
      document.getElementById('profileCarStatus').textContent = summary.carApprovalStatus || user.carApprovalStatus || 'pending';
      document.getElementById('profileCarsOnRent').textContent = summary.totalVehicles ?? 0;
      document.getElementById('profileEarnings').textContent = formatMoney(summary.totalEarnings || 0);
      document.getElementById('profileRideStats').textContent = `Paid: ${summary.paidBookings || 0} · Active: ${summary.activeBookings || 0} · Completed: ${summary.completedRentals || 0}`;
    } catch {
      document.getElementById('profileCarStatus').textContent = user.carApprovalStatus || 'pending';
      document.getElementById('profileCarsOnRent').textContent = user.totalCarsOnRent || 0;
      document.getElementById('profileEarnings').textContent = formatMoney(user.ownerEarnings || 0);
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    if (!R.requireLogin()) return;
    user = getStoredUser();
    try {
      const me = await api('/auth/me');
      user = me.user;
      setSession({ token: getToken(), user });
    } catch { return; }

    const notice = new URLSearchParams(location.search).get('notice');
    const noticeBox = document.getElementById('profileNotice');
    if (notice === 'owner-only' && noticeBox) {
      noticeBox.innerHTML = '<div class="form-message form-message-error">Vehicle and ride listing tools are available in the Owner portal. Use the role switch below to continue.</div>';
    }

    paintDetails();
    paintRoleBox();
    await loadOwnerFields();

    document.getElementById('becomeOwner')?.addEventListener('click', () => switchRole('owner', 'list-vehicle.html'));
    document.getElementById('becomeUser')?.addEventListener('click', () => switchRole('user', 'index.html'));
    document.getElementById('editProfileForm')?.addEventListener('submit', saveProfile);
    document.getElementById('removePhoto')?.addEventListener('click', () => {
      removePhotoRequested = !removePhotoRequested;
      document.getElementById('removePhoto').classList.toggle('btn-danger', removePhotoRequested);
      document.getElementById('removePhoto').classList.toggle('btn-outline', !removePhotoRequested);
      document.getElementById('editPhoto').disabled = removePhotoRequested;
      showToast(removePhotoRequested ? 'The photo will be removed when you save.' : 'Photo removal cancelled.', 'info');
    });
    document.getElementById('editPhoto')?.addEventListener('change', () => {
      removePhotoRequested = false;
      document.getElementById('removePhoto').classList.remove('btn-danger');
      document.getElementById('removePhoto').classList.add('btn-outline');
    });
    document.getElementById('refreshNotifications')?.addEventListener('click', loadNotifications);
    loadNotifications();
    document.getElementById('notificationList')?.addEventListener('click', async event => {
      const button = event.target.closest('[data-read-notification]');
      if (!button) return;
      try {
        await api(`/notifications/${encodeURIComponent(button.dataset.readNotification)}/read`, { method: 'PATCH' });
        await loadNotifications();
      } catch (error) { showToast(error.message, 'bad'); }
    });
    document.getElementById('logoutBtn')?.addEventListener('click', () => { clearSession(); location.href = 'index.html'; });

    // Appearance (dark / light)
    const themeBox = document.getElementById('themeChoice');
    if (themeBox && global.RevaxTheme) {
      const paint = theme => themeBox.querySelectorAll('[data-theme-pick]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.themePick === theme)));
      paint(global.RevaxTheme.get());
      global.RevaxTheme.onChange(paint);
      themeBox.addEventListener('click', event => {
        const pick = event.target.closest('[data-theme-pick]');
        if (pick) global.RevaxTheme.set(pick.dataset.themePick);
      });
    }
  });
})(window);
