document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('loginForm'); if (!form) return;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]'); if (button) { button.disabled = true; button.textContent = 'Logging in…'; }
    try {
      const data = await api('/auth/login', { method: 'POST', body: { userId: document.getElementById('userId')?.value.trim(), password: document.getElementById('password')?.value } });
      setSession(data);
      const requested = new URLSearchParams(location.search).get('next');
      const fallback = data.user.role === 'admin' ? 'admin.html' : data.user.role === 'owner' ? 'list-vehicle.html' : 'index.html';
      const allowed = ['index.html', 'rental.html', 'find-ride.html', 'bookings.html', 'profile.html', 'list-vehicle.html', 'offer-ride.html'];
      const destination = requested && allowed.some(page => requested === page || requested.startsWith(`${page}#`)) ? requested : fallback;
      location.href = destination;
    } catch (error) { alert(error.message); } finally { if (button) { button.disabled = false; button.textContent = 'Log in'; } }
  });
});
